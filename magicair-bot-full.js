process.env["NTBA_FIX_319"] = 1;
process.env["NTBA_FIX_350"] = 1;

const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require('openai');
const fs = require('fs');
const { Pool } = require('pg');
const express = require('express');
const fetch = globalThis.fetch;

const app = express();
app.use(express.json());

// 🔽 новый endpoint для сообщений от веб-клиента
app.post('/message-from-web', async (req, res) => {
  try {
    const { clientId, message } = req.body;

    if (!clientId || !message) {
      return res.status(400).json({ error: 'clientId и message обязательны' });
    }

    console.log(`🌐 Вхідне з сайту: ${clientId} → ${message}`);

    // если клиент уже подключён к менеджеру → пересылаем менеджеру
    const managerId = userStates[clientId]?.managerId;
    if (managerId && activeManagerChats[managerId] === clientId) {
      await bot.sendMessage(managerId, `👤 Веб-клієнт (${clientId}): ${message}`);
      await logMessage(clientId, managerId, message, 'client');
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('❌ /message-from-web error:', err.message || err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Инициализация подключения к БД
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
}) : null;

// Инициализация таблицы при запуске
async function initDatabase() {
  if (!pool) {
    console.log('⚠️ DATABASE_URL не найден, используется локальное сохранение');
    return false;
  }
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bot_data (
        key VARCHAR(255) PRIMARY KEY,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 🆕 НОВЫЕ ТАБЛИЦЫ ДЛЯ ИСТОРИИ
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        from_id BIGINT,
        to_id BIGINT,
        message TEXT,
        type VARCHAR(20),
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (
        chat_id BIGINT PRIMARY KEY,
        name VARCHAR(255),
        phone VARCHAR(50),
        birthday VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Создаем индексы для быстрого поиска
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_id);
      CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_id);
      CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);
      CREATE INDEX IF NOT EXISTS idx_profiles_phone ON profiles(phone);
    `);

    console.log('✅ База данных PostgreSQL инициализирована с таблицами истории');
    return true;
  } catch (error) {
    console.error('❌ Ошибка инициализации БД:', error);
    return false;
  }
}

// ========== CONFIG ==========
// ВАЖНО: Токен тепер загружается из переменной окружения!
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('⛔️ TELEGRAM_BOT_TOKEN не знайдено в змінних оточеннях!');
  process.exit(1);
}

const MANAGERS = process.env.MANAGER_IDS
  ? process.env.MANAGER_IDS.split(',').map(s => parseInt(s.trim())).filter(Boolean)
  : [
      7764495189, 
      5106454153,
      /* третій ID */
    ];
// --- Додайте console.log сюди ---
console.log('Список менеджерів:', MANAGERS);
// ------------------------------------

const MANAGERS_DATA = {
  7764495189: "Микола",
  5106454153: "Володимир",
};

// НОВЫЕ ПЕРЕМЕННЫЕ ДЛЯ ГРАФИКА
const WORKING_HOURS = {
    start: 9, // 9:00
    end: 21 // 21:00
};

const bot = new TelegramBot(token, {
  polling: {
    interval: 2000,
    autoStart: true,
    params: { timeout: 10 }
  },
  request: {
    agentOptions: {
      keepAlive: true,
      family: 4
    }
  }
});

let openai = null;
if (process.env.OPENAI_API_KEY) {
  try {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    console.log('✅ OpenAI підключений');
  } catch (err) {
    console.log('⚠️ OpenAI не підключений:', err.message);
  }
} else {
  console.log('⚠️ OPENAI_API_KEY не знайдений');
}

// ========== STATE ==========
const userStates = {};
const waitingClients = new Set();
const activeManagerChats = {};
const messageLog = [];
const userProfiles = {};
const managerLocks = {};
const activePromotions = [];
const userConversationHistory = {}; // 🆕 Зберігаємо історію розмов для AI
const holidays = [
  { date: '14.02', name: 'День Святого Валентина', emoji: '💕' },
  { date: '08.03', name: 'Міжнародний жіночий день', emoji: '🌸' },
  { date: '01.01', name: 'Новий рік', emoji: '🎊' },
  { date: '25.12', name: 'Різдво', emoji: '🎄' },
  { date: '31.10', name: 'Хелловін', emoji: '🎃' }
];

const managerNotifications = {}; // Хранит ID уведомлений о новых клиентах с кнопкой "Почати чат"
// ========== ANTISPAM ==========
const userRateLimit = new Map();
const MAX_MESSAGES_PER_MINUTE = 30;
const BLOCK_DURATION = 5 * 60 * 1000; // 5 хвилин

function checkRateLimit(chatId) {
  const now = Date.now();
  let userLimit = userRateLimit.get(chatId);

  if (!userLimit) {
    userLimit = { count: 0, resetTime: now + 60 * 1000, blockedUntil: 0 };
    userRateLimit.set(chatId, userLimit);
  }

  // якщо користувач заблокований
  if (now < userLimit.blockedUntil) {
    const remainingMs = userLimit.blockedUntil - now;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { allowed: false, waitMinutes: remainingMinutes };
  }

  // якщо хвилинне вікно минуло → обнуляємо
  if (now > userLimit.resetTime) {
    userLimit.count = 0;
    userLimit.resetTime = now + 60 * 1000;
  }

  userLimit.count++;

  if (userLimit.count > MAX_MESSAGES_PER_MINUTE) {
    userLimit.blockedUntil = now + BLOCK_DURATION;
    const remainingMs = userLimit.blockedUntil - now;
    const remainingMinutes = Math.ceil(remainingMs / 60000);
    return { allowed: false, waitMinutes: remainingMinutes };
  }

  return { allowed: true };
}

const isManager = id => MANAGERS.includes(id);
const getManagerName = id => MANAGERS_DATA[id] || `Менеджер (${id})`;

// ========== MENUS ==========
const mainMenu = {
  reply_markup: {
    keyboard: [
      ['🛒 Каталог', '❓ FAQ'],
      ['📱 Сайт', '📞 Контакти'],
      ['🔍 Пошук', '💬 Менеджер'],
      ['👤 Профіль']
    ],
    resize_keyboard: true
  }
};
const managerMenu = {
  reply_markup: {
    keyboard: [
      ['📋 Клієнти', '🎁 Активні акції'],
      ['📄 Журнал', '🔍 Пошук історії'],
      ['📊 Статистика', '📢 Масова розсилка'],
      ['🛑 Завершити чат']
    ],
    resize_keyboard: true
  }
};

// ========== НОВОЕ МЕНЮ ДЛЯ ЗАКАЗОВ ==========
const orderCollectionMenu = {
  reply_markup: {
    keyboard: [
      ['✅ Відправити замовлення менеджеру'],
      ['🏠 Головне меню']
    ],
    resize_keyboard: true
  }
};

const clientInChatMenu = {
  reply_markup: {
    keyboard: [
      ['🏠 Головне меню']
    ],
    resize_keyboard: true
  }
};

function buildProfileMenu(chatId) {
  const profile = userProfiles[chatId];
  const inline = [];

  if (!profile || !profile.name) {
    inline.push([{ text: '📝 Заповнити профіль', callback_data: 'fill_profile' }]);
  } else {
    inline.push([{ text: '👤 Мій профіль', callback_data: 'show_profile' }]);
  }

  inline.push([{ text: '✏️ Редагувати дані', callback_data: 'edit_profile' }]);
  inline.push([{ text: '🔔 Налаштування сповіщень', callback_data: 'notification_settings' }]);
  inline.push([{ text: '🏠 Головне меню', callback_data: 'main_menu' }]);

  return { reply_markup: { inline_keyboard: inline } };
}

const catalogMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🎈 Латексні кулі', callback_data: 'cat_latex' }],
      [{ text: '✨ Фольговані кулі', callback_data: 'cat_foil' }],
      [{ text: '🎁 Готові набори', callback_data: 'cat_sets' }],
      [{ text: '🎉 Товари для свята', callback_data: 'cat_party' }],
      [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
    ]
  }
};
const latexMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🔴 Однотонні', callback_data: 'latex_plain' }],
      [{ text: '🎨 З малюнком', callback_data: 'latex_pattern' }],
      [{ text: '✨ З конфеті', callback_data: 'latex_confetti' }],
      [{ text: '🌈 Агат/Браш', callback_data: 'latex_agate' }],
      [{ text: '🎀 З бантиками', callback_data: 'latex_bow' }],
      [{ text: '⬅️ Назад', callback_data: 'catalog' }]
    ]
  }
};
const foilMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🦄 Фігури', callback_data: 'foil_figures' }],
      [{ text: '🔢 Цифри', callback_data: 'foil_numbers' }],
      [{ text: '🚶 Ходячі фігури', callback_data: 'foil_walking' }],
      [{ text: '🎨 З малюнком', callback_data: 'foil_pattern' }],
      [{ text: '💖 Серця/Зірки', callback_data: 'foil_hearts' }],
      [{ text: '⬅️ Назад', callback_data: 'catalog' }]
    ]
  }
};
const setsMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🎈 Готові набори кульок', callback_data: 'sets_bouquets' }],
      [{ text: '📦 Сюрприз коробки', callback_data: 'sets_boxes' }],
      [{ text: '📸 Фотозона', callback_data: 'sets_photozone' }],
      [{ text: '⬅️ Назад', callback_data: 'catalog' }]
    ]
  }
};
const partyMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🕯️ Свічки', callback_data: 'party_candles' }],
      [{ text: '🌸 Аромадифузори', callback_data: 'party_aroma' }],
      [{ text: '🎪 Декор для свята', callback_data: 'party_decor' }],
      [{ text: '⬅️ Назад', callback_data: 'catalog' }]
    ]
  }
};
const faqMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '🚚 Доставка та оплата', callback_data: 'faq_delivery' }],
      [{ text: '🎈 Про кулі та гелій', callback_data: 'faq_balloons' }],
      [{ text: '📅 Замовлення та терміни', callback_data: 'faq_orders' }],
      [{ text: '🎁 Оформлення та декор', callback_data: 'faq_decoration' }],
      [{ text: '📞 Контакти та режим роботи', callback_data: 'faq_contacts' }],
      [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
    ]
  }
};
const prefilterMenu = {
  reply_markup: {
    inline_keyboard: [
      [{ text: '💰 Питання про ціни', callback_data: 'filter_price' }],
      [{ text: '🚚 Доставка та оплата', callback_data: 'filter_delivery' }],
      [{ text: '🎈 Вибір кульок', callback_data: 'filter_balloons' }],
      [{ text: '🎉 Оформлення свята', callback_data: 'filter_event' }],
      [{ text: '🚨Термінове питання', callback_data: 'filter_urgent' }],
      [{ text: '❓ Інше питання', callback_data: 'filter_other' }]
    ]
  }
};

// ========== HELPERS ==========
function isWorkingHours() {
    const now = new Date();
    const kievTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Kiev"}));
    const hours = kievTime.getHours();
    
    return hours >= WORKING_HOURS.start && hours < WORKING_HOURS.end;
}

// ========== VALIDATION FUNCTIONS ==========
function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') return { isValid: false, error: 'Номер телефону не може бути пустим' };
  
  const cleanPhone = phone.replace(/[\s\-\(\)\+]/g, '');
  
  // Проверяем украинские номера
  let isValid = false;
  let normalizedPhone = '';
  
  if (cleanPhone.startsWith('380')) {
    isValid = /^380[0-9]{9}$/.test(cleanPhone) && cleanPhone.length === 12;
    normalizedPhone = '+' + cleanPhone;
  } else if (cleanPhone.startsWith('0')) {
    isValid = /^0[0-9]{9}$/.test(cleanPhone) && cleanPhone.length === 10;
    normalizedPhone = '+38' + cleanPhone;
  } else if (cleanPhone.length === 9) {
    // Номер без кода страны и без 0
    isValid = /^[0-9]{9}$/.test(cleanPhone);
    normalizedPhone = '+380' + cleanPhone;
  }
  
  if (!isValid) {
    return {
      isValid: false,
      error: 'Невірний формат номера телефону.\n\nПриклади правильного формату:\n• +380501234567\n• 0501234567\n• 380501234567\n\nСпробуйте ще раз:'
    };
  }
  
  return { isValid: true, normalizedPhone };
}

function validateBirthday(date) {
  if (!date || typeof date !== 'string') return { isValid: false, error: 'Дата не може бути пустою' };
  
  const match = date.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) {
    return {
      isValid: false,
      error: 'Невірний формат дати.\nВикористовуйте формат ДД.ММ.РРРР (наприклад: 15.03.1990):'
    };
  }
  
  const [_, day, month, year] = match;
  const dayNum = parseInt(day);
  const monthNum = parseInt(month);
  const yearNum = parseInt(year);
  
  // Проверяем существование даты
  const dateObj = new Date(yearNum, monthNum - 1, dayNum);
  if (dateObj.getDate() !== dayNum || 
      dateObj.getMonth() !== monthNum - 1 || 
      dateObj.getFullYear() !== yearNum) {
    return {
      isValid: false,
      error: 'Така дата не існує. Перевірте правильність введення:'
    };
  }
  
  // Проверяем разумные границы
  const now = new Date();
  const age = now.getFullYear() - yearNum;
  
  if (yearNum < 1900 || yearNum > now.getFullYear()) {
    return {
      isValid: false,
      error: 'Рік народження повинен бути від 1900 до поточного року:'
    };
  }
  
  if (dateObj > now) {
    return {
      isValid: false,
      error: 'Дата народження не може бути в майбутньому:'
    };
  }
  
  if (age > 120) {
    return {
      isValid: false,
      error: 'Перевірте правильність року народження:'
    };
  }
  
  return { isValid: true };
}

function validateName(name) {
  if (!name || typeof name !== 'string') return { isValid: false, error: 'Ім\'я не може бути пустим' };
  
  const cleaned = name.trim().replace(/[<>\"']/g, '');
  
  if (cleaned.length < 1) {
    return { isValid: false, error: 'Ім\'я не може бути пустим' };
  }
  
  if (cleaned.length > 50) {
    return { isValid: false, error: 'Ім\'я надто довге (максимум 50 символів)' };
  }
  
  // Только буквы, пробелы, дефисы, апострофы
  if (!/^[а-яїієґА-ЯЇІЄҐA-Za-z\s\-']+$/.test(cleaned)) {
    return {
      isValid: false,
      error: 'Ім\'я може містити тільки букви, пробіли та дефіси:'
    };
  }
  
  return { isValid: true, cleanedName: cleaned };
}

function sanitizeMessage(message) {
  if (!message || typeof message !== 'string') return '';
  
  // Убираем потенциально опасные HTML теги и скрипты
  return message
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/javascript:/gi, '')
    .trim()
    .substring(0, 4000); // Ограничиваем длину
}

// ======= УЛУЧШЕННАЯ функція розпізнавання замовлень =======
function isOrderMessage(text) {
  if (!text) return false;
  const t = text.toLowerCase();

  // Ключові слова дій (замовлення)
  const directOrderKeywords = [
    "замовити", "замовлення", "замовлю", "заказать",
    "купити", "придбати",
    "доставка", "доставку", "привезіть",
    "можна доставку", "потрібно", "нужны шарики", "замов", "оформити",
    "можна замовити", "хочу замовити", "хочу заказать", // 🆕 фрази з контекстом
  ];

  // Ключові слова товарів
  const itemKeywords = [
    "кулі", "шари", "повітряні кулі", "гелієві кулі", "набір", "шарики",
    "цифри", "фігури", "кульок", "штук", "латексні", "фольговані",
    "однотонні", "з малюнком", "з конфеті", "агат", "браш", "з бантиками",
    "серце", "зірка", "цифра", "цифру", "цифри", "букви", "баблс" // 🆕 розширено
  ];

  // FAQ запитання — не вважаємо замовленням
  const faqQuestions = [
    "скільки коштує", "яка ціна", "скільки буде", "скільки коштують", "ціна",
    "які є", "які бувають", "показати варіанти", "каталог", "асортимент",
    "як оплатити", "оплата", "можна карткою", "передоплата", "накладений платіж",
    "чи є доставка", "скільки доставка", "як працює доставка", "чи доставляєте",
    "самовивіз", "де забрати", "адреса", "де знаходитесь",
    "о котрій", "коли працюєте", "години роботи", "чи працюєте сьогодні", "чи працюєте завтра",
    "чи є гарантія", "з чого зроблені", "якої якості", "чи безпечні", "скільки тримаються"
  ];

  // Якщо це FAQ запитання → не замовлення
  if (faqQuestions.some(q => t.includes(q))) {
    return false;
  }

  // Перевірка: ключові слова дії + товар
  const hasDirectAction = directOrderKeywords.some(kw => t.includes(kw));
  const hasItem = itemKeywords.some(kw => t.includes(kw));

  if (hasDirectAction && hasItem) {
    return true;
  }

  // Особливі випадки — короткі замовлення типу "5 кульок", "10 шарів завтра"
  const hasQuantityAndItem = /\d+\s*(штук|шт|кульок|кулі|шарів|шарики|цифри|фігура)/i.test(t);
  if (hasQuantityAndItem) {
    return true;
  }

  return false;
}

// ======= Новая проверка полноты заказа =======
function isCompleteOrder(text) {
  const t = text.toLowerCase();

  const hasQuantity = /\d+/.test(t) || t.includes("шт") || t.includes("штук");
  const hasType = /(латексні|фольговані|цифри|фігури|різнокольрові|однотон)/.test(t);
  const hasDate = /(сьогодні|завтра|післязавтра|\d{1,2}\.\d{1,2}|\d{1,2}:\d{2})/.test(t);
  const hasStore = /(оболонь|теремки|самовивіз)/.test(t);

  // теперь заказ считается полным только если указано хотя бы 2 детали
  const detailsCount = [hasQuantity, hasType, hasDate, hasStore].filter(Boolean).length;
  return detailsCount >= 2;
}

// ======= Новая функция проверки контекста заказа =======
function isOrderContext(chatId) {
  const profile = userProfiles[chatId];
  if (!profile) return false;

  const recentOrderTime = 5 * 60 * 1000; // 5 минут
  return profile.lastOrderTime && (Date.now() - profile.lastOrderTime) < recentOrderTime;
}

// ======= Улучшенная функция проверки уточнений заказа =======
function isOrderClarification(text, chatId) {
  if (!text) return false;
  const t = text.toLowerCase();

  if (!isOrderContext(chatId)) return false;

  const clarificationKeywords = [
    "латексні", "фольговані", "різнокольорові", "однотонні",
    "з малюнком", "з конфеті", "агат", "браш", "з бантиками",
    "цифри", "фігури", "серця", "зірки", "ходячі",
    "теремки", "оболонь", "самовивіз", "доставка"
  ];

  const clarificationPhrases = [
    "заберу з", "з якого магазину", "які саме",
    "коли можна", "о котрій", "завтра", "сьогодні"
  ];

  const hasKeyword = clarificationKeywords.some(kw => t.includes(kw));
  const hasPhrase = clarificationPhrases.some(phrase => t.includes(phrase));

  return hasKeyword || hasPhrase;
}

// ======= Активация благодарности =======
function isThanksMessage(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  const thanksKeywords = [
    "дякую", "спасибі", "дуже дякую", "вдячний",
    "спасибо", "благодарю", "очень благодарен"
  ];
  return thanksKeywords.some(kw => t.includes(kw));
}

// ========== ERRORS ==========
bot.on('error', (error) => {
  console.error('🚨 Bot Error:', error.message);
});
bot.on('polling_error', (error) => {
  console.error('🚨 Polling Error:', error.code || error.message);
  if (error.message && (
    error.message.includes('certificate') ||
    error.message.includes('ECONNRESET') ||
    error.message.includes('EFATAL')
  )) {
    console.log('⚠️ Temporary connection issue - continuing...');
    return;
  }
});

// ========== START ==========
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'друже';
  console.log(`▶️ START: ${chatId}, Managers: ${MANAGERS.join(',')}`);

  try {
    if (isManager(chatId)) {
      const managerName = getManagerName(chatId);
      console.log(`✅ Менеджер ${managerName} (${chatId}) активований`);
      await bot.sendMessage(chatId,
        `👨‍💼 Привіт, ${managerName}!\n🆔 ID: ${chatId}\n✅ Бот готовий до роботи`,
        managerMenu
      );
    } else {
      userStates[chatId] = { step: 'menu' };
      await bot.sendMessage(chatId,
  `🎈 Привіт, ${userName}!\n\n` +
  `Вітаємо в MagicAir — магазині гелійових кульок в Києві 🎉\n\n` +
  `✅ Ви можете користуватися навігаційним меню нижче.\n` +
  `📷 Нова зручність! Тепер можна надіслати фото вподобаних кульок чи написати текстове замовлення — і я автоматично передам його менеджеру.\n` +
  `🤖 Я твій бот помічник,напишіть питання у чат — і я одразу відповім\n\n` +
  `👩‍💼 Покличте менеджера для більш детальної консультації, якщо потрібно.`,
  mainMenu
);
    }
  } catch (error) {
    console.error('⚠ Start error:', error);
  }
});

// ========== MESSAGES ==========
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Клієнт';
  const text = msg.text || '';
// 🚫 Якщо замовлення вже відправлено і чат ще не почався
  const profile = userProfiles[chatId];
if (
  profile?.orderLocked === true &&
  profile?.orderStatus === 'sent' && // ✅ заказ действительно отправлен
  !Object.values(activeManagerChats).includes(chatId) // не в чате
) {
  await bot.sendMessage(chatId, "🕓 Очікуйте відповіді менеджера, будь ласка 🙏");
  return;
}

  // 🚫 Антиспам
  const rateStatus = checkRateLimit(chatId);
  if (!rateStatus.allowed) {
    await bot.sendMessage(
      chatId,
      `🚫 Ви надто часто надсилаєте повідомлення. Спробуйте знову через ${rateStatus.waitMinutes} хвилин.`
    ).catch(() => {});
    return;
  }

  // 👨‍💼 Якщо це менеджер
  if (isManager(chatId)) {
    const managerId = chatId;
    const clientId = activeManagerChats[managerId];

    // 🖼 Фото від менеджера
    if (msg.photo) {
      if (clientId) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const caption = msg.caption || '';
        await bot.sendPhoto(clientId, fileId, {
          caption: `👨‍💼 ${getManagerName(managerId)}: ${caption || '(без коментаря)'}`
        });
        await logMessage(managerId, clientId, `[ФОТО] ${caption}`, 'manager');
      } else {
        await bot.sendMessage(managerId, 'ℹ️ Спочатку оберіть клієнта, щоб надіслати фото.');
      }
      return; // ⚠️ Не вважаємо це замовленням
    }

    // Текстове повідомлення від менеджера
    await handleManagerMessage(msg);
    return;
  }

  // 🖼 Фото від клієнта
  if (msg.photo) {
    const managerId = Object.keys(activeManagerChats).find(
      mId => activeManagerChats[mId] == chatId
    );
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const caption = msg.caption || '';

    if (managerId) {
      // Якщо клієнт у чаті з менеджером → пересилаємо фото
      await bot.sendPhoto(managerId, fileId, {
        caption: `📷 ${userName} (${chatId}):\n${caption || '(без коментаря)'}`
      });
      await bot.sendMessage(chatId, '📸 Фото відправлено менеджеру ✅');
      await logMessage(chatId, managerId, `[ФОТО] ${caption}`, 'client');
      return; // ⚠️ Не створюємо нове замовлення
    }

    // Інакше — нове фото-замовлення
    return await handlePhotoMessage(msg);
  }

  // ⚙️ Команди
  if (text && text.startsWith('/')) {
    if (text === '/end') {
      await handleEndCommand(chatId);
    }
    return;
  }

  console.log(`📨 ${chatId} (${userName}): ${text}`);

  try {
    // 💬 Якщо клієнт зараз у чаті з менеджером
    const managerId = Object.keys(activeManagerChats).find(
      mId => activeManagerChats[mId] == chatId
    );

    if (managerId) {
      // 🏠 Кнопка "Головне меню" → завершення чату
      if (text === '🏠 Головне меню') {
        delete activeManagerChats[managerId];
        delete userStates[chatId];

        await bot.sendMessage(
          chatId,
          '✅ Чат завершено. Ви повернулись до головного меню.',
          mainMenu
        );
        await bot.sendMessage(
          managerId,
          `❌ Клієнт ${userName} (${chatId}) завершив чат.`,
          managerMenu
        );
        return;
      }

      // 🔁 Пересилання повідомлення менеджеру
      await bot.sendMessage(managerId, `💬 ${userName} (${chatId}): ${text}`);
      await logMessage(chatId, managerId, text, 'client');
      console.log(`💬 Повідомлення від ${chatId} переслано менеджеру ${managerId}`);
      return;
    }
    
    // 1️⃣ НОВЫЙ БЛОК: ОБРАБОТКА СТАНДАРТНЫХ КНОПОК МЕНЮ (БЕЗ БЛОКИРОВКИ)
    switch (text) {
        case '🏠 Головне меню':
            // Очистка всех состояний блокировки при возврате в Главное меню
            if (userProfiles[chatId]) {
                userProfiles[chatId].orderLocked = false;
                delete userProfiles[chatId].orderStatus;
                delete userProfiles[chatId].pendingPhotoOrder;
            }
            await bot.sendMessage(chatId, 'Ви повернулись до головного меню. Оберіть дію:', mainMenu);
            return;
            
        case '🛒 Каталог':
            await bot.sendMessage(chatId, '✨ Оберіть категорію кульок, що цікавить:', catalogMenu);
            return;
            
        case '❓ FAQ':
            await bot.sendMessage(chatId, '📚 Часті запитання:', faqMenu);
            return;

        case '📞 Контакти':
            await bot.sendMessage(chatId, 
                '📍 Ми знаходимось в Києві, працюємо з 9:00 до 21:00.\n' + 
                '📞 Зв\'яжіться з нами: +380991234567\n' + 
                '🌐 Наш сайт: [magicair.com.ua](https://magicair.com.ua/)'
            );
            return;
            
        case '👤 Профіль':
            await bot.sendMessage(chatId, '📋 Ваш профіль:', buildProfileMenu(chatId)); 
            return;
            
        case '💬 Менеджер':
            await bot.sendMessage(chatId, '💬 Щоб швидко передати ваше питання менеджеру, оберіть тему:', prefilterMenu); 
            return;
            
        case '📱 Сайт':
        case '🔍 Пошук':
            await bot.sendMessage(chatId, `🌐 Наш сайт: [magicair.com.ua](https://magicair.com.ua/)`);
            return;
    }

    // 🧩 Якщо менеджер ще не підключився
const profile = userProfiles[chatId];
const lastOrderTime = profile?.lastOrderTime;

// 🚫 Якщо замовлення вже відправлено або чат завершено — не приймаємо уточнення
if (!profile || profile.orderStatus === 'sent' || userStates[chatId]?.step === 'manager_chat_end') {
  await handleClientMessage(msg);
  return;
}

// 📷 Фото-замовлення — дозволяємо тільки одне уточнення
if (profile?.pendingPhotoOrder) {
  const order = profile.pendingPhotoOrder;
    
  // 1. ПЕРЕХВАТ КНОПКИ ОТПРАВКИ ЗАКАЗА
if (text === "✅ Відправити замовлення менеджеру") {
    // Проверяем, что есть хотя бы фото или уже добавлено уточнение
    if (!order.fileId) { // ✅ ИСПРАВЛЕНО: используем fileId, которое сохраняется в handlePhotoMessage
      await bot.sendMessage(chatId, "❌ Помилка замовлення. Спробуйте надіслати фото знову.");
      return;
    }
    
    // Вызываем отправку заказа, которая должна установить profile.orderLocked = true
    await finalizeAndSendOrder(chatId, userName); 
    return;
}
    
  // 2. ПРИЕМ УТОЧНЕНИЯ (если caption еще нет)
  // ✏️ Якщо фото без підпису → приймаємо одне уточнення
  if (!order.caption && text && text !== "🏠 Головне меню") {
    order.caption = text;

    await bot.sendMessage(
      chatId,
      `✅ Уточнення додано: "${text}"\n\nНатисніть "✅ Відправити замовлення менеджеру", щоб відправити.`,
      {
        reply_markup: {
          keyboard: [
            [{ text: "✅ Відправити замовлення менеджеру" }],
            [{ text: "🏠 Головне меню" }]
          ],
          resize_keyboard: true
        }
      }
    );
    return;
  }
    
  // 3. БЛОКИРОВКА ПРИ ПОПЫТКЕ ГОВОРИТЬ ПОСЛЕ УТОЧНЕНИЯ (Fix 1: Ложная блокировка)
  // Если у нас уже есть caption (уточнение), но кнопку отправки еще не нажали,
  // просто просим нажать на кнопку, чтобы не попадать в логику AI/handleClientMessage
  if (order.caption) {
    await bot.sendMessage(chatId, "💬 Будь ласка, натисніть '✅ Відправити замовлення менеджеру' або '🏠 Головне меню'.");
    return;
  }

  // 🔄 Если пользователь пишет что-то, что не является уточнением, и заказ еще не отправлен
  await handleClientMessage(msg); 
  return;
}

// 🕒 Текстове замовлення — дозволяємо уточнення протягом 60 секунд
else if (lastOrderTime && Date.now() - lastOrderTime < 60 * 1000) {
  await handleOrderClarification(chatId, text, userName);
  return;
}
    // 🧠 Усі інші повідомлення → AI / створення нового замовлення
    await handleClientMessage(msg);

  } catch (error) {
    console.error('⚠ Message error:', error);
    await bot.sendMessage(chatId, '⚠ Помилка. Спробуйте /start').catch(() => {});
  }
});

// ==================== ОБРОБКА КНОПОК INLINE ====================
bot.on('callback_query', async (query) => {
  const managerId = query.from.id;
  const data = query.data || '';

  try {
    // ========== 🟢 Менеджер починає чат з клієнтом ==========
    if (data.startsWith('client_chat_')) {
      const raw = data.replace('client_chat_', '');
      const clientId = raw.startsWith('site-') ? raw : parseInt(raw, 10);

      // 🟢 Убрана проверка блокировки managerLocks
      // (Теперь менеджер не блокируется, всё реагирует мгновенно)

      // 🆕 Проверяем, доступен ли клиент вообще
      if (!waitingClients.has(clientId) && !waitingClients.has(String(clientId))) {
        const hasNotification = managerNotifications[managerId] && 
                                managerNotifications[managerId][clientId];
        if (!hasNotification) {
          await bot.answerCallbackQuery(query.id, {
            text: "❌ Цей клієнт більше недоступний для чату",
            show_alert: true
          });

          // Удаляем неактуальную кнопку
          try {
            await bot.editMessageReplyMarkup(
              { inline_keyboard: [] },
              { chat_id: managerId, message_id: query.message.message_id }
            );
          } catch (err) {}
          return;
        }
      }

      // 🔍 Проверяем статусы клиента и менеджера
      const isWaiting = waitingClients.has(clientId) || waitingClients.has(String(clientId));
      const isOccupied = Object.values(activeManagerChats).some(id =>
        id === clientId || id === String(clientId)
      );
      const hasActiveChat = activeManagerChats[managerId] !== undefined;

      if (!isWaiting && !isOccupied) {
        await bot.answerCallbackQuery(query.id, {
          text: "❌ Цей клієнт більше недоступний для чату",
          show_alert: true
        });
        try {
          await bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: managerId, message_id: query.message.message_id }
          );
        } catch (err) {
          console.log("Не вдалося прибрати кнопку:", err.message);
        }
        return;
      }

      if (hasActiveChat && activeManagerChats[managerId] !== clientId) {
        await bot.answerCallbackQuery(query.id, {
          text: "⚠️ Завершіть поточний чат перед початком нового",
          show_alert: true
        });
        return;
      }

      if (isOccupied && !activeManagerChats[managerId]) {
        const occupiedBy = Object.entries(activeManagerChats)
          .find(([_, cId]) => cId === clientId || cId === String(clientId));

        if (occupiedBy) {
          const otherManagerName = getManagerName(parseInt(occupiedBy[0]));
          await bot.answerCallbackQuery(query.id, {
            text: `⚠️ Клієнт вже спілкується з ${otherManagerName}`,
            show_alert: true
          });
          return;
        }
      }

      // 🚀 Всё в порядке — запускаем чат
      await startManagerChatWithClient(managerId, clientId);
      await bot.answerCallbackQuery(query.id);
    }

    // ========== 🕓 Історія чатів ==========
    else if (data.startsWith('history_chat_')) {
      const clientId = parseInt(data.replace('history_chat_', ''));
      if (activeManagerChats[managerId] && activeManagerChats[managerId] !== clientId) {
        await bot.answerCallbackQuery(query.id, {
          text: "⚠️ Завершіть поточний чат перед початком нового",
          show_alert: true
        });
        return;
      }
      await startManagerChatWithClient(managerId, clientId, true);
      await bot.answerCallbackQuery(query.id);
    }

    // ========== 📜 Перегляд історії ==========
    else if (data.startsWith('show_history_')) {
      const parts = data.split('_');
      const clientId = parts[2];
      const offset = parseInt(parts[3] || 0);
      await sendClientHistory(managerId, clientId, offset);
      await bot.answerCallbackQuery(query.id);
    }

    // ========== 📦 Відправити замовлення ==========
    else if (data === '✅ Відправити замовлення менеджеру') {
      await finalizeAndSendOrder(managerId, query.from.first_name || 'Клієнт');
      await bot.answerCallbackQuery(query.id);
    }

    // ========== 🏠 Головне меню ==========
    else if (data === '🏠 Головне меню') {
      await bot.sendMessage(managerId, "📋 Головне меню:", managerMenu);
      await bot.answerCallbackQuery(query.id);
    }

  } catch (err) {
    console.error("⚠ callback_query error:", err);
    await bot.answerCallbackQuery(query.id, {
      text: "❌ Помилка обробки запиту",
      show_alert: true
    });
  }
});

// ==================== ЛОГИКА ОТСЛЕЖИВАННЯ І ФІНАЛІЗАЦІЇ ====================
function initOrderTracking(chatId) {
  if (!userProfiles[chatId]) {
    userProfiles[chatId] = { chatId, clarifications: [] };
  }
  
  userProfiles[chatId].orderStatus = 'collecting'; // collecting -> ready -> sent
  userProfiles[chatId].clarifications = [];
  userProfiles[chatId].lastOrderTime = Date.now();
}

function setAutoFinalize(chatId, userName) {
  const profile = userProfiles[chatId];
  if (!profile) return;

  if (profile.autoSendTimer) {
    clearTimeout(profile.autoSendTimer);
  }

  profile.autoSendTimer = setTimeout(async () => {
    if (profile && (profile.orderStatus === 'ready' || profile.orderStatus === 'collecting')) {
      await finalizeAndSendOrder(chatId, userName);
    }
  }, 5 * 60 * 1000);
}

// ==================== ОБРОБКА ФОТО ====================
async function handlePhotoMessage(msg) {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Клієнт';
  const caption = msg.caption || '';
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  console.log(`📷 Фото отримано від ${chatId} (${userName}): ${caption}`);

  // 🟢 Якщо клієнт зараз у чаті з менеджером — просто пересилаємо фото
  const managerId = Object.keys(activeManagerChats).find(
    mId => activeManagerChats[mId] == chatId
  );

  if (managerId) {
    try {
      await bot.sendPhoto(managerId, fileId, {
        caption: `📷 ${userName} (${chatId}):\n${caption || '(без коментаря)'}`
      });
      await logMessage(chatId, managerId, `[ФОТО] ${caption}`, 'client');
      console.log(`📷 Фото від ${chatId} переслано менеджеру ${managerId}`);
      return; // ⚠️ Не створюємо нове замовлення
    } catch (err) {
      console.error(`❌ Не вдалося переслати фото менеджеру ${managerId}:`, err.message);
      return;
    }
  }

  // 🔥 Якщо менеджер ще не підключився — стандартна логіка замовлення
  if (!userProfiles[chatId]) {
    userProfiles[chatId] = { chatId, created: Date.now(), clarifications: [] };
  }

  initOrderTracking(chatId);

  // 🔥 Фіксуємо, що це фото-замовлення
  userProfiles[chatId].orderType = 'photo';
  userProfiles[chatId].pendingPhotoOrder = { fileId, caption };
  userProfiles[chatId].lastPhotoOrder = { fileId, caption };
  userProfiles[chatId].lastOrder = caption || "(фото без коментаря)";
  userProfiles[chatId].orderStatus = caption ? 'ready' : 'collecting';

  if (!caption) {
    await bot.sendMessage(chatId,
      "📷 Ви надіслали фото кульок. Щоб оформити замовлення, уточніть, будь ласка:\n\n" +
      "📅 На коли потрібна доставка?\n" +
      "📍 Доставка чи самовивіз?\n\n" +
      "💡 Ви можете додати деталі зараз або натиснути кнопку відправки.\n" +
      "⏰ У вас є 5 хвилин для уточнень.",
      orderCollectionMenu
    );
  } else {
    await bot.sendMessage(chatId,
      "✅ Ваше фото-замовлення готове до відправки!\n\n" +
      "🎯 Натисніть '✅ Відправити замовлення менеджеру' щоб відправити зараз\n" +
      "📝 Або додайте ще деталі протягом 5 хвилин\n" +
      "⏰ Замовлення автоматично відправиться менеджеру через 5 хвилин",
      orderCollectionMenu
    );
  }

  setAutoFinalize(chatId, userName);
}
// ==================== ФІНАЛІЗАЦІЯ ЗАМОВЛЕННЯ ====================
async function finalizeAndSendOrder(chatId, userName) {

  // 🚫 Блокуємо подальші уточнення
  const profile = userProfiles[chatId];
  if (profile) profile.orderLocked = true;

  if (!profile || profile.orderStatus === 'sent') return;

  profile.orderStatus = 'sent';

  // очищаем таймер автопідтвердження
  if (profile.autoSendTimer) {
    clearTimeout(profile.autoSendTimer);
    delete profile.autoSendTimer;
  }

  // блок уточнень
  let clarificationsBlock = "";
  if (profile.clarifications?.length > 0) {
    clarificationsBlock =
      "\n\n➡️ Уточнення:\n" + profile.clarifications.join("\n");
  }

  // підтвердження клієнту
  await bot.sendMessage(
    chatId,
    "✅ Ваше замовлення відправлено менеджеру для підтвердження. Незабаром з вами зв'яжуться.\n\n" +
      "🌐 Або ви можете оформити замовлення самостійно: https://magicair.com.ua",
    mainMenu
  );

  waitingClients.add(chatId);

  // знаходимо вільних менеджерів
  const freeManagers = MANAGERS.filter((id) => !activeManagerChats[id]);
  const notifyList = freeManagers.length ? freeManagers : MANAGERS;

  // ======= Відправка замовлення менеджеру =======
  if (profile.orderType === "photo" && profile.lastPhotoOrder) {
    for (const managerId of notifyList) {
      try {
        const actualCaption =
          profile.pendingPhotoOrder?.caption ||
          profile.lastPhotoOrder.caption ||
          "(без коментаря)";

        const sentMsg = await bot.sendPhoto(
          managerId,
          profile.lastPhotoOrder.fileId,
          {
            caption:
              `📷 Фото-замовлення від ${userName} (ID: ${chatId}):\n\n` +
              `📝 Опис замовлення: ${actualCaption}${clarificationsBlock || ""}`,
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "💬 Почати чат з клієнтом",
                    callback_data: `client_chat_${chatId}`,
                  },
                ],
              ],
            },
          }
        );

        // ✅ Зберігаємо ID повідомлення для подальшого оновлення
        if (!managerNotifications[managerId])
          managerNotifications[managerId] = {};
        managerNotifications[managerId][chatId] = {
          messageId: sentMsg.message_id,
          isPhoto: true,
          fileId: profile.lastPhotoOrder.fileId,
        };
      } catch (err) {
        console.error(
          "❌ Failed to notify manager with photo order:",
          err.message
        );
      }
    }
  } else {
    for (const managerId of notifyList) {
      try {
        const sentMsg = await bot.sendMessage(
          managerId,
          `🆕 Фінальне замовлення від ${userName} (ID: ${chatId}):\n\n${profile.lastOrder}${clarificationsBlock || ""}`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "💬 Почати чат з клієнтом",
                    callback_data: `client_chat_${chatId}`,
                  },
                ],
              ],
            },
          }
        );

        // ✅ Зберігаємо ID повідомлення
        if (!managerNotifications[managerId])
          managerNotifications[managerId] = {};
        managerNotifications[managerId][chatId] = {
          messageId: sentMsg.message_id,
          isPhoto: false,
        };
      } catch (err) {
        console.error(
          "❌ Failed to notify manager with text order:",
          err.message
        );
      }
    }
  }

  // очищуємо тимчасові дані
  profile.clarifications = [];
  delete profile.orderStatus;
  delete profile.orderType;
}

// ===================== ОБРОБКА ПРЯМОГО ЗАМОВЛЕННЯ (ОНОВЛЕНО) =====================
async function handleDirectOrder(chatId, text, userName) {
  console.log(`📦 Direct order detected from ${chatId}, text: ${text}`);

  if (!userProfiles[chatId]) {
    userProfiles[chatId] = { chatId, clarifications: [] };
  }

  // НОВОЕ: инициализируем отслеживание заказа
  initOrderTracking(chatId);
  userProfiles[chatId].lastOrder = text;
  userProfiles[chatId].lastMessage = text;
  userProfiles[chatId].lastActivity = Date.now();

  // Проверка деталей заказа
  const hasQuantity = /\d+/.test(text) || /штук|шт\b/i.test(text);
  const hasSpecificType = /(латексні|фольговані|цифри|фігури|ходячі|серця|зірки|однотонні|з малюнком|з конфеті|агат|браш|з бантиками)/i.test(text);
  const hasDate = /(сьогодні|завтра|післязавтра|\d{1,2}\.\d{1,2}|\d{1,2}:\d{2})/i.test(text);
  const hasStore = /(оболонь|теремки|самовивіз)/i.test(text);

  const detailsCount = [hasQuantity, hasSpecificType, hasDate, hasStore].filter(Boolean).length;
  const hasEnoughDetails = detailsCount >= 2;

  if (!hasEnoughDetails) {
    let clarificationMessage = "Для оформлення замовлення, будь ласка, уточніть:\n\n";
    if (!hasQuantity) clarificationMessage += "📦 Скільки кульок потрібно?\n";
    if (!hasSpecificType) clarificationMessage += "🎈 Які саме кульки: латексні, фольговані, цифри?\n";
    if (!hasDate) clarificationMessage += "📅 На коли потрібна доставка?\n";
    if (!hasStore) clarificationMessage += "📍 Доставка чи самовивіз (з якого магазину)?\n";

    clarificationMessage += "\n💡 Ви можете додати деталі зараз або натиснути кнопку '✅ Відправити замовлення менеджеру' щоб відправити те що є.\n";
    clarificationMessage += "⏰ У вас є 5 хвилин для уточнень, після чого замовлення автоматично відправиться менеджеру.";

    await bot.sendMessage(chatId, clarificationMessage, orderCollectionMenu);

    // НОВОЕ: централизованный запуск таймера автоотправки
    setAutoFinalize(chatId, userName);

    return;
  }

  // Если заказ полный → сразу готов к отправке
  userProfiles[chatId].orderStatus = 'ready';

  await bot.sendMessage(chatId,
    "✅ Ваше замовлення готове до відправки!\n\n" +
    "🎯 Натисніть '✅ Відправити замовлення менеджеру' щоб відправити зараз\n" +
    "📝 Або додайте ще деталі протягом 5 хвилин\n" +
    "⏰ Замовлення автоматично відправиться менеджеру через 5 хвилин",
    orderCollectionMenu
  );

  // НОВОЕ: запускаем таймер
  setAutoFinalize(chatId, userName);
}

// ==================== ОБРОБКА УТОЧНЕНЬ ====================
async function handleOrderClarification(chatId, text, userName) {
  const profile = userProfiles[chatId];

  // 🚫 Якщо профіль не знайдено або замовлення вже відправлено
  if (!profile || profile.orderStatus === 'sent') {
    await handleGeneralMessage(chatId, text, userName);
    return;
  }

  // 🏠 Повернення до меню
  if (text === '🏠 Головне меню') return;

  // ✅ Якщо клієнт натиснув кнопку відправки
  if (text === '✅ Відправити замовлення менеджеру') {
    await finalizeAndSendOrder(chatId, userName);
    return;
  }

  // 🕒 Якщо час уточнень минув (більше 5 хв)
  if (Date.now() - profile.lastOrderTime > 5 * 60 * 1000) {
    await bot.sendMessage(
      chatId,
      "⏰ Час для уточнень минув. Ваше замовлення вже відправлено менеджеру.\n\n" +
      "Щоб зробити нове замовлення — просто опишіть його заново 👇",
      mainMenu
    );
    return;
  }

  // 🔥 Якщо менеджер ще не прийняв чат — дозволяємо тільки одне уточнення
  if (profile.orderType === 'photo' && profile.clarifications?.length >= 1) {
    await bot.sendMessage(
      chatId,
      "ℹ️ Ви вже додали уточнення. Тепер натисніть '✅ Відправити замовлення менеджеру' щоб завершити.",
      orderCollectionMenu
    );
    return;
  }

  // 🔹 Зберігаємо уточнення
  if (!profile.clarifications) profile.clarifications = [];
  profile.clarifications.push(text);

  console.log(`✏️ Clarification added from ${chatId}: ${text}`);

  await bot.sendMessage(
    chatId,
    `✅ Уточнення додано!\n\n` +
    "🎯 Натисніть '✅ Відправити замовлення менеджеру', щоб завершити.",
    orderCollectionMenu
  );
}

// ===================== CLIENT HANDLER =====================
async function handleClientMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const userName = msg.from.first_name || 'Клієнт';

  if (userProfiles[chatId]) userProfiles[chatId].lastActivity = Date.now();

  if (userStates[chatId]?.step === 'manager_chat') {
    if (text === '🏠 Головне меню') {
      await handleEndCommand(chatId);
      return;
    }
    await forwardToManager(chatId, text, userName);
    return;
  }

  if (isThanksMessage(text)) {
    await bot.sendMessage(chatId, "💜 Дякуємо і вам! Радий був допомогти 🎈");
    return;
  }

  const isDirectOrder = isOrderMessage(text);
  const isOrderClarif = isOrderClarification(text, chatId);

  if (!userProfiles[chatId]) {
    userProfiles[chatId] = { 
      chatId, 
      created: Date.now(), 
      notifications: true, 
      holidayNotifications: [],
      clarifications: [] 
    };
  }

  if (isDirectOrder) return await handleDirectOrder(chatId, text, userName);
  if (isOrderClarif) return await handleOrderClarification(chatId, text, userName);

  // ========= SWITCH ПО КНОПКАМ =========
  switch (text) {
  case '🏠 Головне меню':
    await bot.sendMessage(chatId, '🏠 Головне меню:', mainMenu);
    return;
      
    case '🛒 Каталог':
      await bot.sendMessage(chatId, '🛒 Каталог товарів MagicAir:\n\nОберіть категорію:', catalogMenu);
      return;

    case '❓ FAQ':
      await sendInteractiveFAQ(chatId);
      return;

    case '📱 Сайт':
      await bot.sendMessage(chatId,
        '🌍 Наш сайт:\n👉 https://magicair.com.ua\n\n🛒 Тут ви можете переглянути повний каталог та оформити замовлення!',
        { reply_markup: { inline_keyboard: [
            [{ text: '🛒 Відкрити сайт', url: 'https://magicair.com.ua' }],
            [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]}}
      );
      return;

    case '📞 Контакти':
      await sendContacts(chatId);
      return;

    case '🔍 Пошук':
      userStates[chatId] = { step: 'search' };
      await bot.sendMessage(chatId, '🔍 Введіть назву товару для пошуку:');
      return;

     case '💬 Менеджер':
    if (isWorkingHours()) {
      await startPreFilter(chatId, userName);
    } else {
      await bot.sendMessage(chatId,
        `⏰ Ви звернулися в неробочий час.\n\n` +
        `Графік роботи менеджерів: **з ${WORKING_HOURS.start}:00 до ${WORKING_HOURS.end}:00**.\n\n` +
        `Чекаємо на вас завтра в робочий час!`,
        { parse_mode: 'Markdown', ...mainMenu }
      );
    }
    return;

  case '👤 Профіль':
    await showProfile(chatId);
    return;

  // 🔥 НОВЫЙ CASE ДЛЯ КНОПКИ "Відправити замовлення"
  case '✅ Відправити замовлення менеджеру': {
    const profile = userProfiles[chatId];
    if (profile) {
      if (profile.orderStatus === 'sent') {
        await bot.sendMessage(
          chatId,
          "⚠️ Ваше замовлення вже було відправлено менеджеру. Створіть нове замовлення, якщо потрібно.",
          mainMenu
        );
      } else if (profile.orderStatus === 'collecting' || profile.orderStatus === 'ready') {
        await finalizeAndSendOrder(chatId, userName);
      } else {
        await bot.sendMessage(
          chatId,
          "У вас немає активного замовлення для відправки. Створіть нове замовлення.",
          mainMenu
        );
      }
    }
    return;
  }
} // ✅ закрываем switch (text)

  // ========= ДАЛЕЕ ОБРАБОТКА ПРОФИЛЯ / ПОИСКА =========
  if (userStates[chatId]?.step?.startsWith('profile_')) {
    await handleProfileInput(chatId, text, userStates[chatId].step);
    return;
  }
  if (userStates[chatId]?.step === 'search') {
    await handleSearch(chatId, text);
    delete userStates[chatId];
    return;
  }

  // ========= ОСТАЛЬНЫЕ СООБЩЕНИЯ =========
  await handleGeneralMessage(chatId, text, userName);
}

// ===================== MANAGER HANDLER =====================
async function handleManagerMessage(msg) {
  const managerId = msg.chat.id;
  const text = msg.text || '';

  const managerCommands = ['📋 Клієнти', '🎁 Активні акції', '📄 Журнал', '🛑 Завершити чат', '📊 Статистика', '🎁 Створити акцію'];

  if (userStates[managerId]?.step?.startsWith('promo_')) {
    await handlePromotionInput(managerId, text, userStates[managerId].step);
    return;
  }

  if (activeManagerChats[managerId] && !managerCommands.includes(text)) {
  const clientId = activeManagerChats[managerId];
  const messageText = `👨‍💼 ${getManagerName(managerId)}: ${text}`;

  if (String(clientId).startsWith('site-')) {
    // Веб-клиент → отправляем через мост
    await sendToWebClient(clientId, messageText);
  } else {
    // Телеграм-клиент → обычная отправка
    await bot.sendMessage(clientId, messageText);
  }

  await logMessage(managerId, clientId, text, 'manager');
  return;
}

  switch (text) {
    case '📋 Клієнти':
      delete userStates[managerId];
      await showClientsList(managerId);
      break;

    case '🎁 Активні акції':
      delete userStates[managerId];
      await showPromotionsList(managerId);
      break;

    case '📄 Журнал':
      delete userStates[managerId];
      await showMessageLog(managerId);
      break;

    case '🔍 Пошук історії':
      userStates[managerId] = { step: 'search_history' };
      await bot.sendMessage(managerId,
        '🔍 Введіть для пошуку:\n\n' +
        '• ID клієнта\n' +
        '• Ім\'я клієнта\n' +
        '• Номер телефону\n\n' +
        'Приклад: 123456789 або Іван або 0501234567'
      );
      break;

    case '🛑 Завершити чат':
      delete userStates[managerId];
      await endManagerChat(managerId);
      break;

    case '📊 Статистика':
      delete userStates[managerId];
      await showStats(managerId);
      break;

    case '📢 Масова розсилка':
      delete userStates[managerId];
      await startCustomBroadcast(managerId);
      break;

    case '🎁 Створити акцію':
      delete userStates[managerId];
      await startPromotionCreation(managerId);
      break;

  default:
  if (!activeManagerChats[managerId]) {
    await bot.sendMessage(managerId, '👨‍💼 Будь ласка, оберіть дію з меню.');
  }
  break;
}

if (userStates[managerId]?.step === 'search_history' && text !== '🔍 Пошук історії') {
  await searchClientHistory(managerId, text.trim());
  return;
}

if (userStates[managerId]?.step === 'broadcast_message' && text !== '📢 Масова розсилка') {
  await handleBroadcastInput(managerId, text);
  return;
}
}
// ========== CALLBACK QUERIES ==========
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;

  // Обработка истории сообщений
  if (data.startsWith('show_history_')) {
    const parts = data.split('_');
    const clientId = parts[2];
    const offset = parseInt(parts[3] || 0);
    await sendClientHistory(chatId, clientId, offset);
    await bot.answerCallbackQuery(query.id);
    return;
  }

  await bot.answerCallbackQuery(query.id).catch(() => {});

  try {
    switch (data) {
      // --- Каталог ---
      case 'catalog':
        await bot.editMessageText('🛒 Каталог товарів MagicAir:\n\nОберіть категорію:',
          { chat_id: chatId, message_id: messageId, ...catalogMenu });
        break;
      case 'cat_latex':
        await bot.editMessageText('🎈 Латексні гелієві кулі:\n\nОберіть підкатегорію:',
          { chat_id: chatId, message_id: messageId, ...latexMenu });
        break;
      case 'cat_foil':
        await bot.editMessageText('✨ Фольговані гелієві кулі:\n\nОберіть підкатегорію:',
          { chat_id: chatId, message_id: messageId, ...foilMenu });
        break;
      case 'cat_sets':
        await bot.editMessageText('🎁 Готові набори:\n\nОберіть тип:',
          { chat_id: chatId, message_id: messageId, ...setsMenu });
        break;
      case 'cat_party':
        await bot.editMessageText('🎉 Товари для свята:\n\nОберіть категорію:',
          { chat_id: chatId, message_id: messageId, ...partyMenu });
        break;

      // --- Latex ---
      case 'latex_plain':
        await sendProductInfo(chatId, messageId,
          '🔴 Однотонні латексні кулі (80-110 грн)',
          'Класичні однотонні кулі всіх кольорів. Пастельні, металік, хром.',
          'https://magicair.com.ua/lateksnye-shary/'
        );
        break;
      case 'latex_pattern':
        await sendProductInfo(chatId, messageId,
          '🎨 Латексні кулі з малюнком (95-120 грн)',
          'Яскраві кулі з різноманітними малюнками та принтами.',
          'https://magicair.com.ua/heliievi-kulky-z-maliunkom/'
        );
        break;
      case 'latex_confetti':
        await sendProductInfo(chatId, messageId,
          '✨ Кулі з конфеті (115 грн)',
          'Прозорі кулі з яскравими конфеті всередині.',
          'https://magicair.com.ua/shary-s-konfetti/'
        );
        break;
      case 'latex_agate':
        await sendProductInfo(chatId, messageId,
          '🌈 Кулі Агат/Браш (120-125 грн)',
          'Унікальні кулі з мармуровим ефектом.',
          'https://magicair.com.ua/heliievi-kulky-ahat-brash/'
        );
        break;
      case 'latex_bow':
        await sendProductInfo(chatId, messageId,
          '🎀 Кулі з бантиками від 175грн',
          'Елегантні кулі з атласними бантиками.',
          'https://magicair.com.ua/heliievi-kulky-z-bantykamy/'
        );
        break;

      // --- Foil ---
      case 'foil_figures':
        await sendProductInfo(chatId, messageId,
          '🦄 Фольговані фігури (350-900 грн)',
          'Фігурні кулі: тваринки, персонажі, предмети.',
          'https://magicair.com.ua/folgirovannye-figury/'
        );
        break;
      case 'foil_numbers':
        await sendProductInfo(chatId, messageId,
          '🔢 Фольговані цифри (385-590 грн)',
          'Цифри 70 та 100см для днів народження та річниць.',
          'https://magicair.com.ua/folhovani-tsyfry/'
        );
        break;
      case 'foil_walking':
        await sendProductInfo(chatId, messageId,
          '🚶 Ходячі фігури',
          'Унікальні кулі-фігури, що "ходять" по підлозі.',
          'https://magicair.com.ua/khodyachie-shary/'
        );
        break;
      case 'foil_pattern':
        await sendProductInfo(chatId, messageId,
          '🎨 Фольговані з малюнком',
          'Фольговані кулі з яскравими малюнками та написами.',
          'https://magicair.com.ua/folgirovannye-shary-s-risunkom/'
        );
        break;
      case 'foil_hearts':
        await sendProductInfo(chatId, messageId,
          '💖 Серця та зірки однотонні',
          'Романтичні серця та святкові зірки.',
          'https://magicair.com.ua/bez-maliunka/'
        );
        break;

      // --- Sets ---
      case 'sets_bouquets':
        await sendProductInfo(chatId, messageId,
          '🎈 Набори кульок (695-11670 грн)',
          'Готові композиції з кульок для різних подій.',
          'https://magicair.com.ua/bukety-sharov/'
        );
        break;
      case 'sets_boxes':
        await sendProductInfo(chatId, messageId,
          '📦 Сюрприз коробки (745-4300 грн)',
          'Коробки 70см з кульками всередині - незабутній сюрприз!',
          'https://magicair.com.ua/surpriz-boksy/'
        );
        break;
      case 'sets_photozone':
        await sendProductInfo(chatId, messageId,
          '📸 Фотозона',
          'Фотозони та гірлянди з повітряних куль.',
          'https://magicair.com.ua/fotozona/'
        );
        break;

      // --- Party ---
      case 'party_candles':
        await sendProductInfo(chatId, messageId,
          '🕯️ Святкові свічки',
          'Свічки для торту та декору. Великий вибір натуральних ароматичних свічок',
          'https://magicair.com.ua/svechi/'
        );
        break;
      case 'party_aroma':
        await sendProductInfo(chatId, messageId,
          '🌸 Аромадифузори',
          'Ароматичні дифузори для затишної атмосфери.',
          'https://magicair.com.ua/aromadyfuzor/'
        );
        break;
      case 'party_decor':
        await sendProductInfo(chatId, messageId,
          '🎪 Декор для свята',
          'Різноманітні товари для оформлення свят.',
          'https://magicair.com.ua/tovary-dlia-sviata/'
        );
        break;

      // --- FAQ ---
      case 'faq_delivery': await sendDeliveryInfo(chatId, messageId); break;
      case 'faq_balloons': await sendBalloonsInfo(chatId, messageId); break;
      case 'faq_orders': await sendOrdersInfo(chatId, messageId); break;
      case 'faq_decoration': await sendDecorationInfo(chatId, messageId); break;
      case 'faq_contacts': await sendContactsInfo(chatId, messageId); break;
      case 'faq_back':
        await bot.editMessageText('❓ Часті питання:\n\nОберіть тему, що вас цікавить:',
          { chat_id: chatId, message_id: messageId, ...faqMenu });
        break;

      // --- Главное меню ---
      case 'main_menu':
        if (userStates[chatId]?.step === 'manager_chat') {
          await handleEndCommand(chatId);
        }
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        await bot.sendMessage(chatId, '🏠 Головне меню:\n\nОберіть опцію:', mainMenu);
        break;

      // --- Поиск, контакты, профиль ---
      case 'contact_manager':
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        await startPreFilter(chatId, query.from.first_name || 'Клієнт');
        break;
      case 'fill_profile':
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        await startProfileCreation(chatId);
        break;
      case 'edit_profile':
        await showEditOptions(chatId, messageId);
        break;
      case 'notification_settings':
        await toggleNotifications(chatId, messageId);
        break;
      case 'show_profile':
        await bot.deleteMessage(chatId, messageId).catch(() => {});
        await showProfile(chatId);
        break;
      case 'edit_name':
        userStates[chatId] = { step: 'profile_name' };
        await bot.editMessageText('Введіть нове ім\'я:', { chat_id: chatId, message_id: messageId });
        break;
      case 'edit_phone':
        userStates[chatId] = { step: 'profile_phone' };
        await bot.editMessageText('Введіть новий номер телефону:', { chat_id: chatId, message_id: messageId });
        break;

      case 'edit_birthday': {
        const profile = userProfiles[chatId];
        const now = Date.now();
        if (profile && profile.birthday_changed_at) {
          const diff = now - profile.birthday_changed_at;
          if (diff < 365 * 24 * 60 * 60 * 1000) {
            const daysLeft = Math.ceil((365 * 24 * 60 * 60 * 1000 - diff) / (1000 * 60 * 60 * 24));
            await bot.answerCallbackQuery(query.id, { text: `Змінити дату народження можна через ${daysLeft} дн.`, show_alert: true });
            await bot.editMessageText(`🎂 Ви зможете змінити дату народження через ${daysLeft} дн.`, { chat_id: chatId, message_id: messageId });
            break;
          }
        }
        userStates[chatId] = { step: 'profile_birthday' };
        await bot.editMessageText('Введіть нову дату народження (ДД.MM.YYYY):', { chat_id: chatId, message_id: messageId });
        break;
      }

      // --- PROMO и PREFILTER ---
      case 'filter_price':
        await handlePriceFilter(chatId, messageId, query.from.first_name || 'Клієнт');
        break;
      case 'filter_delivery':
        await handleDeliveryFilter(chatId, messageId);
        break;
      case 'filter_balloons':
        await handleBalloonsFilter(chatId, messageId);
        break;
      case 'filter_event':
        await handleEventFilter(chatId, messageId);
        break;
      case 'filter_urgent':
        await connectClientToManager(chatId, messageId, query.from.first_name || 'Клієнт', 'Термінове питання');
        break;
      case 'filter_other':
        await connectClientToManager(chatId, messageId, query.from.first_name || 'Клієнт', 'Інше питання');
        break;

      // ЗДЕСЬ ДОБАВЛЕНА ПЕРЕДАЧА ТЕМЫ для всех "Connect" кнопок
      case 'connect_price':
        await connectClientToManager(chatId, messageId, query.from.first_name || 'Клієнт', 'Питання про ціни');
        break;
      case 'connect_delivery':
        await connectClientToManager(chatId, messageId, query.from.first_name || 'Клієнт', 'Питання про доставку');
        break;
      case 'connect_balloons':
        await connectClientToManager(chatId, messageId, query.from.first_name || 'Клієнт', 'Вибір кульок');
        break;
      case 'connect_event':
        await connectClientToManager(chatId, messageId, query.from.first_name || 'Клієнт', 'Оформлення свята');
        break;
      case 'broadcast_confirm':
        if (userStates[chatId]?.step === 'broadcast_confirm' && userStates[chatId]?.message) {
          const message = userStates[chatId].message;
          delete userStates[chatId];
          await bot.editMessageText(
            '⏳ Розсилка розпочата...',
            { chat_id: chatId, message_id: messageId }
          );
          await executeBroadcast(chatId, message);
        }
        break;

      case 'broadcast_cancel':
        delete userStates[chatId];
        await bot.editMessageText(
          '❌ Розсилка скасована.',
          { chat_id: chatId, message_id: messageId }
        );
        setTimeout(() => {
          bot.sendMessage(chatId, 'Головне меню:', managerMenu);
        }, 1000);
        break;


      // Обработка выбора клиента из очереди менеджером
      default: {
        if (data.startsWith('client_chat_')) {
          const clientIdToConnect = parseInt(data.split('_')[2]);
          await startManagerChatWithClient(chatId, clientIdToConnect);
        } else if (data && data.startsWith('promo_show_')) {
          const key = data.split('_')[2];
          const promo = activePromotions.find(p => String(p.created) === String(key));
          if (!promo) {
            await bot.sendMessage(chatId, 'Акція не знайдена.');
            break;
          }
          await bot.sendMessage(chatId, `🎁 *${promo.title}*\n\n${promo.description}\n\n⏰ До: ${promo.endDate}`, { parse_mode: 'Markdown' });
          break;
        } else if (data && data.startsWith('promo_delete_')) {
          const key = data.split('_')[2];
          const idx = activePromotions.findIndex(p => String(p.created) === String(key));
          if (idx === -1) {
            await bot.sendMessage(chatId, 'Акцію не знайдено або вона вже видалена.');
            break;
          }
          if (!isManager(chatId)) {
            await bot.sendMessage(chatId, 'Тільки менеджери можуть видаляти акції.');
            break;
          }
          const removed = activePromotions.splice(idx, 1)[0];
          await bot.sendMessage(chatId, `🗑 Акцію "${removed.title}" видалено.`);
          break;
        } else {
          break;
        }
      }
    }
  } catch (error) {
    console.error('⚠ Callback error:', error);
  }
});

// ========== ИСПРАВЛЕННАЯ ФУНКЦИЯ ПОДКЛЮЧЕНИЯ К МЕНЕДЖЕРУ ==========
async function connectClientToManager(chatId, messageId, userName, topic = 'Без теми') {
  waitingClients.add(chatId);
  await notifyManagers(chatId, userName, topic); // ПЕРЕДАЕМ НОВЫЙ ПАРАМЕТР

  await bot.editMessageText(
    '⏳ Ваш запит передано менеджеру! Чекайте на відповідь.',
    { chat_id: chatId, message_id: messageId }
  );
}

// ========== НОВАЯ ФУНКЦИЯ УВЕДОМЛЕНИЯ МЕНЕДЖЕРОВ ==========
async function notifyManagers(clientId, userName, topic) { // ДОБАВЛЕНО: topic
  const clientProfile = userProfiles[clientId];
  let clientInfo = `👤 Клієнт: ${userName} (ID: ${clientId})`;
  if (clientProfile && clientProfile.name) {
    clientInfo += `\n📝 Профіль: ${clientProfile.name}`;
    if (clientProfile.phone) clientInfo += `\n📞 ${clientProfile.phone}`;
  }
  
  // ЗДЕСЬ ДОБАВЛЯЕМ ИНФОРМАЦИЮ О ТЕМЕ ВОПРОСА
  const topicMessage = topic ? `\n\n📌 Тема запиту: *${topic}*` : '';

  const freeManagers = MANAGERS.filter(id => !activeManagerChats[id]);

  if (freeManagers.length > 0) {
    for (const managerId of freeManagers) {
      if (!managerId) continue;
      try {
        await bot.sendMessage(managerId,
          `🔔 НОВИЙ КЛІЄНТ!${topicMessage}\n\n${clientInfo}\n\nЩоб підключитися, оберіть його в меню **"📋 Клієнти"**.`
        );
      } catch (error) {
        console.error(`Failed to notify manager ${managerId}:`, error.message);
      }
    }
  } else {
    for (const managerId of MANAGERS) {
      if (!managerId) continue;
      try {
        await bot.sendMessage(managerId, `🔔 Новий клієнт в черзі!${topicMessage}\n\n${clientInfo}\n\n(Всі менеджери зайняті, клієнт чекає)`);
      } catch (error) {
        console.error(`Failed to notify manager ${managerId}:`, error.message);
      }
    }
  }
}

// ==================== ОНОВЛЕНА ФУНКЦІЯ СТАРТУ ЧАТУ ====================
async function startManagerChatWithClient(managerId, clientId, fromHistory = false) {
  const managerName = getManagerName(managerId);

  // Перевіряємо активний чат у менеджера
  if (activeManagerChats[managerId]) {
    const currentClientId = activeManagerChats[managerId];
    
    if (currentClientId === clientId) {
      await bot.sendMessage(managerId, `ℹ️ Ви вже підключені до цього клієнта (${clientId}).`);
      return;
    }

    await bot.sendMessage(managerId, 
      `⚠️ У вас активний чат з клієнтом ${currentClientId}.\n\n` +
      `Спочатку завершіть поточний чат кнопкою "🛑 Завершити чат", ` +
      `а потім спробуйте підключитися до іншого клієнта.`
    );
    return;
  }

  // Перевіряємо, чи клієнт не зайнятий іншим менеджером
  for (const [otherManagerId, otherClientId] of Object.entries(activeManagerChats)) {
    if (otherClientId === clientId && otherManagerId !== managerId.toString()) {
      const otherManagerName = getManagerName(parseInt(otherManagerId));
      await bot.sendMessage(managerId, 
        `❌ Клієнт ${clientId} вже спілкується з ${otherManagerName}.`
      );
      return;
    }
  }

  // Встановлюємо зв'язок
  activeManagerChats[managerId] = clientId;
  userStates[clientId] = { 
    step: 'manager_chat', 
    managerId: managerId,
    startTime: Date.now()
  };
// 🧹 видаляємо запис про сповіщення, щоб уточнення не редагували старе повідомлення
if (managerNotifications[managerId] && managerNotifications[managerId][clientId]) {
  delete managerNotifications[managerId][clientId];
  console.log(`🧹 Видалено запис managerNotifications[${managerId}][${clientId}] після початку чату`);
}
  waitingClients.delete(clientId);
  waitingClients.delete(String(clientId));

  await bot.sendMessage(managerId, `✅ Ви підключені до клієнта (${clientId}).`);

  // Повідомляємо клієнта
  try {
    if (String(clientId).startsWith('site-')) {
      const notificationText = fromHistory
        ? `👨‍💼 Менеджер ${managerName} підключився до чату!`
        : `👨‍💼 Менеджер ${managerName} підключився до чату!\nВін готовий відповісти на ваші запитання.`;
      
      await sendToWebClient(clientId, notificationText);
      
      if (!fromHistory) {
        const welcomeMessage = 'Вітаю! Чим можу вам допомогти?';
        await sendToWebClient(clientId, `👨‍💼 ${managerName}: ${welcomeMessage}`);
        await logMessage(managerId, clientId, welcomeMessage, 'manager');
      }

      // 🟢 Підказка для клієнта
      await sendToWebClient(clientId, "ℹ️ Щоб завершити чат, натисніть '🏠 Головне меню'.");
    } 
    else {
      const notificationText = fromHistory
        ? `👨‍💼 Менеджер ${managerName} підключився до чату!`
        : `👨‍💼 Менеджер ${managerName} підключився до чату!\nВін готовий відповісти на ваші запитання.`;
      
      await bot.sendMessage(clientId, notificationText, clientInChatMenu);
      
      if (!fromHistory) {
        const welcomeMessage = 'Вітаю! Чим можу вам допомогти?';
        await bot.sendMessage(clientId, `👨‍💼 ${managerName}: ${welcomeMessage}`);
        await logMessage(managerId, clientId, welcomeMessage, 'manager');
      }

      // 🟢 Підказка для клієнта
      await bot.sendMessage(
        clientId,
        "ℹ️ Щоб завершити чат, натисніть '🏠 Головне меню'."
      );
    }
  } catch (error) {
    console.error(`Failed to notify client ${clientId}:`, error.message);
    await bot.sendMessage(managerId, 
      `⚠️ Не вдалося надіслати повідомлення клієнту ${clientId}.\n` +
      `Можливо, клієнт заблокував бота або видалив чат.`
    );
    delete activeManagerChats[managerId];
    delete userStates[clientId];
  }
}

// --- ИСПРАВЛЕННАЯ функция для отправки информации о товарах (открывается в Telegram) ---
async function sendProductInfo(chatId, messageId, title, description, url) {
  await bot.editMessageText(
    `*${title}*\n\n${description}`,
    {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔗 Переглянути на сайті', url }],
          [{ text: '💬 Запитати менеджера', callback_data: 'contact_manager' }],
          [{ text: '⬅️ Назад до каталогу', callback_data: 'catalog' }],
          [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

// ========== PROFILE FUNCTIONS ==========
async function showProfile(chatId) {
  const profile = userProfiles[chatId];
  if (!profile || !profile.name) {
    await bot.sendMessage(chatId,
      '👤 Ваш профіль ще не заповнений.\n\nЗаповніть профіль, щоб отримувати персональні знижки та вітання!',
      buildProfileMenu(chatId)
    );
    return;
  }
  const notificationStatus = profile.notifications ? '✅ Увімкнені' : '❌ Вимкнені';
  const memberDays = Math.floor((Date.now() - profile.created) / (1000 * 60 * 60 * 24));
  let profileText = `👤 *Ваш профіль:*\n\n`;
  profileText += `📝 Ім'я: ${profile.name}\n`;
  profileText += `📞 Телефон: ${profile.phone || 'не вказано'}\n`;
  profileText += `🎂 День народження: ${profile.birthday || 'не вказано'}\n`;
  profileText += `🔔 Сповіщення: ${notificationStatus}\n`;
  profileText += `📅 З нами: ${memberDays} днів\n`;
  const today = new Date();
  const nextHoliday = getNextHoliday(today);
  if (nextHoliday) {
    profileText += `\n🎊 Найближче свято: ${nextHoliday.name} ${nextHoliday.emoji} (${nextHoliday.displayDate})`;
  }
  if (activePromotions.length > 0) {
    profileText += '\n\n🎁 *Активні акції:*\n';
    activePromotions.forEach(promo => {
      profileText += `• ${promo.title}\n`;
    });
  }
  await bot.sendMessage(chatId, profileText, {
    parse_mode: 'Markdown',
    ...buildProfileMenu(chatId)
  });
}

async function startProfileCreation(chatId) {
  userStates[chatId] = { step: 'profile_name' };
  await bot.sendMessage(chatId,
    '📝 Давайте заповнимо ваш профіль!\n\n' +
    'Це допоможе нам:\n' +
    '• Надавати персональні знижки\n' +
    '• Відправляти вітання з днем народження\n' +
    '• Краще обслуговувати ваші замовлення\n\n' +
    '👤 Крок 1/3: Як вас звати?\n' +
    '(введіть ваше ім\'я або ім\'я та прізвище)'
  );
}

async function handleProfileInput(chatId, text, step) {
  if (!userProfiles[chatId]) {
    userProfiles[chatId] = {
      chatId: chatId,
      created: Date.now(),
      notifications: true,
      holidayNotifications: []
    };
  }

  // Санитизация входящего текста
  const sanitizedText = sanitizeMessage(text);
  
  switch (step) {
    case 'profile_name': {
      const validation = validateName(sanitizedText);
      if (!validation.isValid) {
        await bot.sendMessage(chatId, validation.error);
        return;
      }
      
      userProfiles[chatId].name = validation.cleanedName;
      userStates[chatId].step = 'profile_phone';
      await bot.sendMessage(chatId,
        '📞 Крок 2/3: Введіть ваш номер телефону:\n(формат: +380XXXXXXXXX)'
      );
      await syncProfileToDB(chatId);
      break;
    }
    
    case 'profile_phone': {
      const validation = validatePhone(sanitizedText);
      if (!validation.isValid) {
        await bot.sendMessage(chatId, validation.error);
        return;
      }
      
      userProfiles[chatId].phone = validation.normalizedPhone;
      userStates[chatId].step = 'profile_birthday';
      await bot.sendMessage(chatId,
        '🎂 Крок 3/3: Введіть дату вашого народження:\n(формат: ДД.MM.YYYY, приклад: 15.03.1990)'
      );
      await syncProfileToDB(chatId);
      break;
    }
    
    case 'profile_birthday': {
      const validation = validateBirthday(sanitizedText);
      if (!validation.isValid) {
        await bot.sendMessage(chatId, validation.error);
        return;
      }
      
      const profile = userProfiles[chatId];
      const now = Date.now();
      if (profile.birthday_changed_at && (now - profile.birthday_changed_at) < 365 * 24 * 60 * 60 * 1000) {
        const daysLeft = Math.ceil((365 * 24 * 60 * 60 * 1000 - (now - profile.birthday_changed_at)) / (1000 * 60 * 60 * 24));
        await bot.sendMessage(chatId, `⛔ Змінити дату народження можна через ${daysLeft} дн.`);
        delete userStates[chatId];
        return;
      }
      
      userProfiles[chatId].birthday = sanitizedText;
      userProfiles[chatId].birthday_changed_at = Date.now();
      delete userStates[chatId];
      
      await saveData();
      await syncProfileToDB(chatId);
      
      await bot.sendMessage(chatId,
        '✅ Профіль успішно створено!\n\n' +
        'Тепер ви будете отримувати:\n' +
        '• 🎁 Персональні знижки\n' +
        '• 🎂 Вітання з днем народження\n' +
        '• 🎊 Спеціальні пропозиції до свят',
        mainMenu
      );
      break;
    }
  }
}
// ========== СИНХРОНІЗАЦІЯ ПРОФІЛІВ ==========
async function syncProfileToDB(chatId) {
  if (!pool) return;
  
  try {
    const profile = userProfiles[chatId];
    if (!profile) return;

    // Убеждаемся, что chatId есть в профиле
    profile.chatId = chatId;

    await pool.query(
      `INSERT INTO profiles (chat_id, name, phone, birthday)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chat_id) DO UPDATE
         SET name = EXCLUDED.name,
             phone = EXCLUDED.phone,
             birthday = EXCLUDED.birthday,
             updated_at = CURRENT_TIMESTAMP`,
      [chatId, profile.name || null, profile.phone || null, profile.birthday || null]
    );

    console.log(`✅ Профіль синхронізовано: ${chatId} (${profile.name || "Без імені"})`);

  } catch (err) {
    console.error("❌ Помилка syncProfileToDB:", err);
  }
}

async function showEditOptions(chatId, messageId) {
  const editMenu = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📝 Змінити ім\'я', callback_data: 'edit_name' }],
        [{ text: '📞 Змінити телефон', callback_data: 'edit_phone' }],
        [{ text: '🎂 Змінити дату народження', callback_data: 'edit_birthday' }],
        [{ text: '⬅️ Назад', callback_data: 'show_profile' }]
      ]
    }
  };
  await bot.editMessageText(
    '✏️ Що бажаєте змінити?',
    { chat_id: chatId, message_id: messageId, ...editMenu }
  );
}

async function toggleNotifications(chatId, messageId) {
  if (!userProfiles[chatId]) {
    userProfiles[chatId] = { notifications: false, created: Date.now(), holidayNotifications: [] };
  }
  userProfiles[chatId].notifications = !userProfiles[chatId].notifications;
  const status = userProfiles[chatId].notifications ? 'увімкнені' : 'вимкнені';
  await bot.editMessageText(
    `🔔 Сповіщення ${status}!`,
    { chat_id: chatId, message_id: messageId }
  );
  setTimeout(() => showProfile(chatId), 2000);
}

// ========== HOLIDAY HELPERS ==========
function parseDayMonth(dateStr) {
  const [d, m] = dateStr.split('.').map(s => parseInt(s, 10));
  return { d, m };
}
function getNextHoliday(fromDate = new Date()) {
  const currentYear = fromDate.getFullYear();
  const candidates = holidays.map(h => {
    const { d, m } = parseDayMonth(h.date);
    let dt = new Date(currentYear, m - 1, d);
    if (dt < fromDate) {
      dt = new Date(currentYear + 1, m - 1, d);
    }
    return { holiday: h, dateObj: dt };
  });
  candidates.sort((a, b) => a.dateObj - b.dateObj);
  const next = candidates[0];
  if (!next) return null;
  const displayDate = `${next.dateObj.getDate().toString().padStart(2, '0')}.${(next.dateObj.getMonth()+1).toString().padStart(2, '0')}.${next.dateObj.getFullYear()}`;
  return { name: next.holiday.name, emoji: next.holiday.emoji, displayDate, dateStr: next.holiday.date };
}

// ========== PROMOTION FUNCTIONS ==========
async function startPromotionCreation(managerId) {
  userStates[managerId] = { step: 'promo_title' };
  await bot.sendMessage(managerId,
    '🎁 Створення нової акції\n\nКрок 1/3: Введіть назву акції:'
  );
}

async function handlePromotionInput(managerId, text, step) {
  if (!userStates[managerId].promoData) {
    userStates[managerId].promoData = {};
  }
  switch (step) {
    case 'promo_title':
      userStates[managerId].promoData.title = text;
      userStates[managerId].step = 'promo_description';
      await bot.sendMessage(managerId,
        'Крок 2/3: Введіть опис акції:'
      );
      break;
    case 'promo_description':
      userStates[managerId].promoData.description = text;
      userStates[managerId].step = 'promo_enddate';
      await bot.sendMessage(managerId,
        'Крок 3/3: Введіть дату закінчення акції (ДД.MM.YYYY):'
      );
      break;
    case 'promo_enddate':
      const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
      if (!dateRegex.test(text)) {
        await bot.sendMessage(managerId,
          '❌ Невірний формат дати. Спробуйте ще раз (приклад: 31.12.2024):'
        );
        return;
      }

      const parts = text.split('.');
      const day = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1; // месяц в JS с 0
      const year = parseInt(parts[2], 10);
      const endDateObj = new Date(year, month, day);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (endDateObj < today) {
        await bot.sendMessage(managerId,
          '❌ Дата закінчення акції не може бути в минулому. Спробуйте ще раз:'
        );
        return;
      }

      const promo = {
        ...userStates[managerId].promoData,
        endDate: text,
        created: Date.now(),
        createdBy: managerId
      };
      activePromotions.push(promo);
      delete userStates[managerId];
      await saveData(); // 💾 Сохраняем акцию сразу!
      await bot.sendMessage(managerId,
        `✅ Акція створена!\n\n📋 ${promo.title}\n📝 ${promo.description}\n⏰ До: ${promo.endDate}`,
        managerMenu
      );
      await notifyClientsAboutPromotion(promo);
      break;
  }
}

async function showPromotionsList(managerId) {
  const promos = activePromotions.slice();
  if (!promos.length) {
    await bot.sendMessage(managerId, 'На даний момент активних акцій немає.', {
      reply_markup: {
        keyboard: [['🎁 Створити акцію', '📋 Клієнти']],
        resize_keyboard: true
      }
    });
    return;
  }

  await bot.sendMessage(managerId, '📋 *Активні акції:*', { parse_mode: 'Markdown' });

  for (const promo of promos) {
    const text = `🎁 *${promo.title}*\n\n${promo.description}\n\n⏰ До: ${promo.endDate}`;
    const kb = [];
    kb.push([{ text: '🗑 Видалити акцію', callback_data: `promo_delete_${promo.created}` }]);

    await bot.sendMessage(managerId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: kb } });
  }

  await bot.sendMessage(managerId, 'Виберіть акцію для видалення або поверніться в головне меню.', managerMenu);
}

async function notifyClientsAboutPromotion(promo) {
  const clientsToNotify = [];
  for (const [chatId, profile] of Object.entries(userProfiles)) {
    if (profile.notifications && profile.name) {
      clientsToNotify.push(chatId);
    }
  }
  
  if (clientsToNotify.length === 0) {
    console.log('📭 Нет клиентов для уведомления об акции');
    return;
  }
  
  // Настройки скорости в зависимости от количества клиентов
  let messagesPerSecond;
  if (clientsToNotify.length <= 50) {
    messagesPerSecond = 5; // Быстро для малого количества
  } else if (clientsToNotify.length <= 200) {
    messagesPerSecond = 3; // Средняя скорость
  } else {
    messagesPerSecond = 2; // Медленно для большого количества
  }
  
  const delayMs = 1000 / messagesPerSecond;
  const estimatedTime = Math.ceil(clientsToNotify.length / messagesPerSecond);
  
  console.log(`📢 Рассылка акции для ${clientsToNotify.length} клиентов`);
  console.log(`⚡ Скорость: ${messagesPerSecond} сообщ/сек, время: ~${estimatedTime} сек`);
  
  let sent = 0;
  let failed = 0;
  let consecutiveErrors = 0;
  
  for (let i = 0; i < clientsToNotify.length; i++) {
    const chatId = clientsToNotify[i];
    
    try {
      await bot.sendMessage(chatId,
        `🎁 Нова акція в MagicAir!\n\n${promo.title}\n\n${promo.description}\n\n⏰ Діє до: ${promo.endDate}\n\n🛒 Встигніть скористатися!`,
        { parse_mode: 'Markdown' }
      );
      
      sent++;
      consecutiveErrors = 0; // Сбрасываем счетчик ошибок
      
      // Прогресс каждые 20%
      const progress = Math.floor((i + 1) / clientsToNotify.length * 100);
      if (progress % 20 === 0 && (i + 1) !== clientsToNotify.length) {
        console.log(`📊 Прогресс: ${progress}% (${sent} отправлено, ${failed} ошибок)`);
      }
      
    } catch (error) {
      failed++;
      consecutiveErrors++;
      
      if (error.message.includes('429')) {
        console.log(`⚠️ Rate limit! Пауза на 3 секунды...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        consecutiveErrors = 0;
      } else if (error.message.includes('403')) {
        console.log(`🚫 Клиент ${chatId} заблокировал бота`);
      } else {
        console.log(`❌ Ошибка отправки ${chatId}: ${error.message}`);
      }
      
      // Если много ошибок подряд - увеличиваем задержку
      if (consecutiveErrors >= 5) {
        console.log(`🐌 Слишком много ошибок, замедляем рассылку...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        consecutiveErrors = 0;
      }
    }
    
    // Задержка между сообщениями
    if (i < clientsToNotify.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  console.log(`🎯 Рассылка завершена! ✅ Успешно: ${sent} | ❌ Ошибок: ${failed}`);
}
// ========== HELPER FUNCTIONS ==========
async function sendContacts(chatId) {
  const contactText = `📞 Контакти MagicAir:

☎️ Телефони:
• (063) 233-33-03
• (095) 634-63-64

📱 Наш Instagram:
• Instagram: magic_air.kiev

📍 Магазини:
• Теремки: Метрологічна 13
• Оболонь: Героїв полку Азов 24/10

🌍 Сайт: magicair.com.ua
🚚 Доставка 24/7 по Києву та області`;

  await bot.sendMessage(chatId, contactText, mainMenu);
}

async function sendInteractiveFAQ(chatId) {
  await bot.sendMessage(chatId,
    '❓ Часті питання:\n\nОберіть тему, яка вас цікавить:',
    faqMenu
  );
}

async function handleSearch(chatId, query) {
  const sanitizedQuery = sanitizeMessage(query);
  
  if (sanitizedQuery.length < 4) {
    await bot.sendMessage(chatId, 
      '🔍 Пошуковий запит надто короткий.\nВведіть мінімум 4 символи:'
    );
    return;
  }
  
  if (sanitizedQuery.length > 30) {
    await bot.sendMessage(chatId, 
      '🔍 Пошуковий запит надто довгий.\nМаксимум 30 символів:'
    );
    return;
  }

  await bot.sendMessage(chatId, '🔍 Шукаємо...');

  const searchUrl = `https://magicair.com.ua/katalog/search/?q=${encodeURIComponent(sanitizedQuery)}`;

  await bot.sendMessage(chatId,
    `🔍 Результати пошуку "${sanitizedQuery}":`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔍 Результати пошуку', url: searchUrl }],
          [{ text: '💬 Запитати менеджера', callback_data: 'contact_manager' }],
          [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

// 🔽 добавили новую функцию
async function sendToWebClient(clientId, message) {
  if (!process.env.BRIDGE_URL) {
    console.error('BRIDGE_URL not set — cannot send to web client');
    return;
  }

  try {
    const res = await fetch(`${process.env.BRIDGE_URL.replace(/\/$/, '')}/message-to-web`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, message }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`❌ sendToWebClient failed: ${res.status} ${text}`);
    } else {
      console.log(`➡️ sendToWebClient OK for ${clientId}`);
    }
  } catch (err) {
    console.error('❌ sendToWebClient error:', err.message || err);
  }
}
// ========== ИСПРАВЛЕННЫЕ ФУНКЦИИ МЕНЕДЖЕРА ==========
async function forwardToManager(clientId, text, userName) {
  const managerId = userStates[clientId]?.managerId;
  
  if (managerId && activeManagerChats[managerId] === clientId) {
    // 🔧 ИСПРАВЛЕНО: Получаем имя менеджера для логирования
    const managerName = getManagerName(managerId);
    await bot.sendMessage(managerId, `👤 ${userName} (${clientId}): ${text}`);
    await logMessage(clientId, managerId, text, 'client');
  } else {
    // 🔧 ИСПРАВЛЕНО: Добавлен лог для отладки
    console.log(`⚠️ Некорректное состояние чата для клиента ${clientId}, очищаем...`);
    delete userStates[clientId];
    
    await bot.sendMessage(clientId, '⚠️ З\'єднання з менеджером втрачено. Спробуйте ще раз.', mainMenu);
  }
}

async function forwardToClient(clientId, text) {
  const managerId = userStates[clientId]?.managerId;
  const managerName = getManagerName(managerId);
  const messageText = `👨‍💼 ${managerName}: ${text}`;

  if (String(clientId).startsWith('site-')) {
    await sendToWebClient(clientId, messageText);
  } else {
    await bot.sendMessage(clientId, messageText);
  }
}

// ==================== ОБНОВЛЕННАЯ ФУНКЦІЯ ЗАВЕРШЕННЯ ЧАТА ====================
async function handleEndCommand(chatId) {
  if (userStates[chatId]?.step === 'manager_chat') {
    const managerId = userStates[chatId].managerId;

    // 🔥 Сразу очищаем состояния
    delete activeManagerChats[managerId];
    delete userStates[chatId];

    // 🧹 Очищаем профиль клиента
    if (userProfiles[chatId]) {
      delete userProfiles[chatId].pendingPhotoOrder;
      delete userProfiles[chatId].lastPhotoOrder;
      delete userProfiles[chatId].lastOrder;
      delete userProfiles[chatId].orderStatus;
      delete userProfiles[chatId].orderType;
      delete userProfiles[chatId].orderLocked; // 🧹 Разблокируем уточнения
      userProfiles[chatId].clarifications = [];
    }

    // Удаляем кнопку у менеджера
    await removeManagerNotificationButton(managerId, chatId);

    // Уведомляем менеджера
    if (managerId) {
      await bot.sendMessage(managerId, `✅ Клієнт завершив чат.`, managerMenu);
    }

    // Уведомляем клиента
    if (String(chatId).startsWith('site-')) {
      await sendToWebClient(chatId, '✅ Чат завершено.');
    } else {
      await bot.sendMessage(chatId, '✅ Чат завершено. Повертаємось до головного меню.', mainMenu);
    }

    return;
  } else if (isManager(chatId)) {
    await endManagerChat(chatId);
  } else {
    await bot.sendMessage(chatId, '🏠 Головне меню:', mainMenu);
  }
}

// ==================== СПРОЩЕНА ФУНКЦІЯ (БЕЗ ВИДАЛЕННЯ КНОПОК) ====================
async function removeManagerNotificationButton(managerId, clientId) {
  // Просто логируем, нічого не змінюємо
  console.log(`ℹ️ Пропущено видалення кнопки для менеджера ${managerId}, клієнт ${clientId}`);
  return;
}

// ==================== ОБНОВЛЕНА ФУНКЦІЯ ЗАВЕРШЕННЯ ЧАТА МЕНЕДЖЕРОМ ====================
async function endManagerChat(managerId) {
  const clientId = activeManagerChats[managerId];

  if (clientId) {
    const managerName = getManagerName(managerId);

    // Очищаємо стани
    delete activeManagerChats[managerId];
    delete userStates[clientId];

    // 🧹 Скидаємо блокування уточнень
    if (userProfiles[clientId]) {
      delete userProfiles[clientId].orderLocked; // 🧹 Сбрасываем блокировку заказов
    }

    // Уведомляємо клієнта
    try {
      if (String(clientId).startsWith('site-')) {
        await sendToWebClient(clientId, `✅ Менеджер ${managerName} завершив чат.`);
      } else {
        await bot.sendMessage(clientId, `✅ Менеджер ${managerName} завершив чат.`, mainMenu);
      }
    } catch (error) {
      console.log(`Не вдалося уведомити клієнта ${clientId} про завершення чату:`, error.message);
    }
  }

  await bot.sendMessage(managerId, '✅ Чат завершено.', managerMenu);
}
// ========== ФУНКЦІЇ ІСТОРІЇ ==========
async function searchClientHistory(managerId, query) {
  if (!pool) {
    await bot.sendMessage(managerId, '⚠️ База даних недоступна');
    return;
  }

  try {
    const cleanQuery = query.trim();
    const phoneQuery = cleanQuery.replace(/[\s\+\-\(\)]/g, ''); // улучшенная нормализация
    
    console.log(`🔍 Поиск клиента: "${cleanQuery}"`);

    // Расширенный поиск в БД
    let profileRes = await pool.query(
      `SELECT chat_id, name, phone, birthday FROM profiles
       WHERE CAST(chat_id AS TEXT) = $1
          OR CAST(chat_id AS TEXT) ILIKE $2
          OR LOWER(name) ILIKE LOWER($3)
          OR REPLACE(REPLACE(REPLACE(REPLACE(phone, '+',''), ' ', ''), '-', ''), '(', '') ILIKE $4
          OR REPLACE(REPLACE(REPLACE(REPLACE(phone, '+',''), ' ', ''), '-', ''), ')', '') ILIKE $4
       ORDER BY 
         CASE 
           WHEN CAST(chat_id AS TEXT) = $1 THEN 1
           WHEN LOWER(name) = LOWER($3) THEN 2
           ELSE 3
         END
       LIMIT 10`,
      [cleanQuery, `%${cleanQuery}%`, `%${cleanQuery}%`, `%${phoneQuery}%`]
    );

    console.log(`📋 Найдено в БД: ${profileRes.rows.length} записей`);

    // Если в БД ничего не найдено, ищем в памяти и синхронизируем
    if (profileRes.rows.length === 0) {
      console.log('🔄 Поиск в памяти...');
      
      const foundInMemory = [];
      for (const [chatId, profile] of Object.entries(userProfiles)) {
        const chatIdStr = chatId.toString();
        const nameMatch = profile.name && profile.name.toLowerCase().includes(cleanQuery.toLowerCase());
        const phoneMatch = profile.phone && profile.phone.replace(/[\s\+\-\(\)]/g, '').includes(phoneQuery);
        const idMatch = chatIdStr === cleanQuery || chatIdStr.includes(cleanQuery);
        
        if (idMatch || nameMatch || phoneMatch) {
          foundInMemory.push({
            chat_id: parseInt(chatId),
            name: profile.name || null,
            phone: profile.phone || null,
            birthday: profile.birthday || null
          });
          
          // Синхронизируем найденный профиль с БД
          await syncProfileToDB(chatId);
        }
      }
      
      if (foundInMemory.length > 0) {
        console.log(`💾 Найдено в памяти и синхронизировано: ${foundInMemory.length} профилей`);
        profileRes = { rows: foundInMemory };
      }
    }

    if (profileRes.rows.length === 0) {
      await bot.sendMessage(managerId, 
        `❌ Клієнта не знайдено по запиту: "${cleanQuery}"\n\n` +
        `Спробуйте ввести:\n` +
        `• Точний ID клієнта\n` +
        `• Повне ім'я\n` +
        `• Номер телефону без пробілів`
      );
      return;
    }

    if (profileRes.rows.length === 1) {
      await sendClientHistory(managerId, profileRes.rows[0].chat_id, 0);
      return;
    }

    // Показываем список найденных клиентов
    let text = `📋 Знайдено клієнтів: ${profileRes.rows.length}\n\n`;
    const buttons = [];

    for (let i = 0; i < Math.min(profileRes.rows.length, 10); i++) {
      const profile = profileRes.rows[i];
      text += `${i + 1}. 👤 ${profile.name || 'Без імені'}\n`;
      text += `   🆔 ${profile.chat_id}\n`;
      if (profile.phone) text += `   📞 ${profile.phone}\n`;
      if (profile.birthday) text += `   🎂 ${profile.birthday}\n`;
      text += '\n';

      buttons.push([{
        text: `${profile.name || profile.chat_id} (${profile.chat_id})`,
        callback_data: `show_history_${profile.chat_id}_0`
      }]);
    }

    await bot.sendMessage(managerId, text, {
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (err) {
    console.error("❌ Помилка searchClientHistory:", err);
    await bot.sendMessage(managerId, '⚠️ Помилка при пошуку історії. Спробуйте ще раз.');
  }
}

async function sendClientHistory(managerId, clientId, offset = 0) {
  if (!pool) {
    bot.sendMessage(managerId, '⚠️ База даних недоступна');
    return;
  }

  try {
    // Профиль клиента
    const profileRes = await pool.query(
      `SELECT chat_id, name, phone, birthday FROM profiles WHERE chat_id = $1`,
      [clientId]
    );

    let profileInfo = '';
    if (profileRes.rows.length > 0) {
      const p = profileRes.rows[0];
      profileInfo = `👤 ${p.name || 'Без імені'} (ID: ${p.chat_id})\n`;
      if (p.phone) profileInfo += `📞 ${p.phone}\n`;
      if (p.birthday) profileInfo += `🎂 ${p.birthday}\n`;
    } else {
      profileInfo = `👤 Клієнт ID: ${clientId}\n`;
    }

    // Сообщения
    const msgs = await pool.query(
      `SELECT * FROM messages
       WHERE from_id = $1 OR to_id = $1
       ORDER BY timestamp DESC
       LIMIT 20 OFFSET $2`,
      [clientId, offset]
    );

    if (msgs.rows.length === 0 && offset === 0) {
      await bot.sendMessage(managerId, profileInfo + '\n⚠️ Історія повідомлень порожня.');
      return;
    }

    if (msgs.rows.length === 0) {
      await bot.sendMessage(managerId, '⚠️ Більше повідомлень немає.');
      return;
    }

    let text = `📂 ІСТОРІЯ СПІЛКУВАННЯ\n\n${profileInfo}\n`;
    text += `📄 Показано: ${offset + 1}-${offset + msgs.rows.length} повідомлень\n━━━━━━━━━━━━━━━\n\n`;

    for (const row of msgs.rows.reverse()) {
      const isFromClient = row.from_id == clientId;
      const icon = row.type === 'manager' ? '👨‍💼' : '👤';
      const direction = isFromClient ? '➡️' : '⬅️';
      const date = new Date(row.timestamp);
      const timeStr = date.toLocaleString('uk-UA', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
      });
      text += `${icon} ${direction} ${timeStr}\n`;
      text += `${(row.message || '').substring(0, 200)}\n\n`;
    }

    const buttons = [];
    const navButtons = [];
    if (offset > 0) {
      navButtons.push({
        text: '⬅️ Попередні',
        callback_data: `show_history_${clientId}_${Math.max(0, offset - 20)}`
      });
    }
    if (msgs.rows.length === 20) {
      navButtons.push({
        text: 'Наступні ➡️',
        callback_data: `show_history_${clientId}_${offset + 20}`
      });
    }
    if (navButtons.length) buttons.push(navButtons);

    buttons.push([{
  text: '💬 Почати чат з клієнтом',
  callback_data: `history_chat_${clientId}`
  }]);

    await bot.sendMessage(managerId, text, {
      reply_markup: { inline_keyboard: buttons },
      parse_mode: 'HTML'
    });

  } catch (err) {
    console.error("❌ Помилка sendClientHistory:", err);
    bot.sendMessage(managerId, '⚠️ Помилка при завантаженні історії.');
  }
}
// ==================== ОЧИСТКА СТАРЫХ УВЕДОМЛЕНЬ ====================
async function showClientsList(managerId) {
 
  let clientsList = '📋 КЛІЄНТИ:\n\n';
  const waitingClientsList = Array.from(waitingClients);

  const hasClients = waitingClientsList.length > 0 || Object.keys(activeManagerChats).length > 0;

  if (!hasClients) {
    clientsList += '🔭 Немає активних клієнтів';
    await bot.sendMessage(managerId, clientsList, managerMenu);
    return;
  }

  if (waitingClientsList.length > 0) {
    clientsList += '⏳ *ОЧІКУЮТЬ:*\n';
    const inlineKeyboard = waitingClientsList.map(clientId => {
      const profile = userProfiles[clientId];
      const name = profile && profile.name ? ` (${profile.name})` : '';
      return [{ text: `💬 Клієнт ${clientId}${name}`, callback_data: `client_chat_${clientId}` }];
    });

    await bot.sendMessage(managerId, clientsList, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: inlineKeyboard
      }
    });
  }

  if (Object.keys(activeManagerChats).length > 0) {
    let activeChatsText = '\n💬 *АКТИВНІ ЧАТИ:*\n';
    for (const [mgrId, clientId] of Object.entries(activeManagerChats)) {
      const profile = userProfiles[clientId];
      const name = profile && profile.name ? ` (${profile.name})` : '';
      const managerName = getManagerName(mgrId);
      activeChatsText += `• ${managerName} ↔ Клієнт ${clientId}${name}\n`;
    }
    await bot.sendMessage(managerId, activeChatsText, { parse_mode: 'Markdown' });
  }
}

async function showMessageLog(managerId) {
  let logText = '📄 ЖУРНАЛ ПОВІДОМЛЕНЬ:\n\n';

  if (messageLog.length === 0) {
    logText += 'Журнал порожній';
  } else {
    const recentMessages = messageLog.slice(-10);
    for (const msg of recentMessages) {
      const date = new Date(msg.timestamp).toLocaleString('uk-UA');
      const type = msg.type === 'manager' ? '👨‍💼' : '👤';
      const fromName = msg.type === 'manager' ? getManagerName(msg.from) : `Клієнт (${msg.from})`;
      logText += `${type} ${fromName} → ${msg.to}\n`;
      logText += `📝 ${msg.message}\n`;
      logText += `🕐 ${date}\n\n`;
    }
  }

  await bot.sendMessage(managerId, logText, managerMenu);
}

async function showStats(managerId) {
  const stats = `📊 СТАТИСТИКА:

👥 Профілів: ${Object.keys(userProfiles).length}
🎁 Активних акцій: ${activePromotions.length}
⏳ Клієнтів в очікуванні: ${waitingClients.size}
💬 Активних чатів: ${Object.keys(activeManagerChats).length}
📝 Записів в журналі: ${messageLog.length}

👨‍💼 Менеджери: ${Object.values(MANAGERS_DATA).join(', ')}`;

  await bot.sendMessage(managerId, stats, managerMenu);
}

// ========== PREFILTER FUNCTIONS ==========
async function startPreFilter(chatId, userName) {
  await bot.sendMessage(chatId,
    `💬 ${userName}, щоб швидше вам допомогти, оберіть тему вашого питання:`,
    prefilterMenu
  );
}

async function handlePriceFilter(chatId, messageId, userName) {
  await bot.editMessageText(
    '💰 Питання про ціни:\n\nЗв\'яжіться з менеджером для детальної консультації',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Зв\'язатися з менеджером', callback_data: 'connect_price' }],
          [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

async function handleDeliveryFilter(chatId, messageId) {
  await bot.editMessageText(
    '🚚 Питання про доставку:\n\nЗв\'яжіться з менеджером для уточнення деталей',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Зв\'язатися з менеджером', callback_data: 'connect_delivery' }],
          [{ text: '📋 FAQ про доставку', callback_data: 'faq_delivery' }],
          [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

async function handleBalloonsFilter(chatId, messageId) {
  await bot.editMessageText(
    '🎈 Вибір кульок:\n\nЗв\'яжіться з менеджером для консультації по вибору',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Зв\'язатися з менеджером', callback_data: 'connect_balloons' }],
          [{ text: '🛒 Переглянути каталог', callback_data: 'catalog' }],
          [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

async function handleEventFilter(chatId, messageId) {
  await bot.editMessageText(
    '🎉 Оформлення свята:\n\nЗв\'яжіться з менеджером для консультації по декору',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Зв\'язатися з менеджером', callback_data: 'connect_event' }],
          [{ text: '🎁 Готові набори', callback_data: 'cat_sets' }],
          [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]
      }
    }
  );
}

// ========== НОВАЯ ФУНКЦИЯ ДЛЯ УМНЫХ ОТВЕТОВ AI ==========
async function handleGeneralMessage(chatId, text, userName) {
  // Санитизація вхідного тексту
  const sanitizedText = sanitizeMessage(text);
  const sanitizedUserName = sanitizeMessage(userName);
  
  if (!sanitizedText || sanitizedText.length < 1) {
    await bot.sendMessage(chatId, 'Повідомлення не може бути пустим.');
    return;
  }
  
  // Ця функція буде викликатись, коли клієнт відправляє любий текст,
  // який не є командою або частью діалогу з менеджером.

  // 1. Перевіряємо, чи є підключення до OpenAI
  if (openai) {
    const userProfile = userProfiles[chatId] || {};
    const now = Date.now();
    const lastActivity = userProfile.lastActivity || 0;
    const timeSinceLastActivity = now - lastActivity; // 🆕 новое имя

    const greetingThreshold = 5 * 60 * 60 * 1000; // 5 часов в миллисекундах
    const shouldGreet = timeSinceLastActivity > greetingThreshold; // заменено

    
    // Перевіряємо, чи містить повідомлення привітання
    const greetingWords = ['привіт', 'привет', 'добрий день', 'добрий ранок', 'добрий вечір', 'здравствуйте', 'вітаю', 'доброго дня', 'добрый день', 'добрый вечер'];
    const messageContainsGreeting = greetingWords.some(word =>
      sanitizedText.toLowerCase().includes(word)
    );
    
    // Визначаємо, чи потрібно привітатись
    const shouldRespondWithGreeting = shouldGreet || messageContainsGreeting;

    
   // 🆕 ДОДАНО: Ініціалізуємо історію розмов для цього клієнта
    if (!userConversationHistory[chatId]) {
      userConversationHistory[chatId] = {
        messages: [],
        lastUpdate: Date.now()
      };
    }
    
    // Очищаємо історію, якщо минуло більше 24 годин
    const timeSinceLastMessage = Date.now() - userConversationHistory[chatId].lastUpdate;
    const ONE_DAY = 24 * 60 * 60 * 1000;
    
    if (timeSinceLastMessage > ONE_DAY) {
      console.log(`🧹 Очищено історію для клієнта ${chatId} (неактивний ${Math.floor(timeSinceLastMessage / 1000 / 60 / 60)} год)`);
      userConversationHistory[chatId].messages = [];
    }
    
 // 2. Створюємо промпт з інструкціями для AI
const systemPrompt = `
Ти — уважний, доброзичливий і професійний помічник магазину повітряних кульок в Києві "MagicAir".  
Твоя головна мета — допомогти клієнтам швидко, ввічливо і чітко, використовуючи **лише дані з <data>**.  
Ніколи не вигадуй ціни чи інформацію, якщо їх немає в <data>.  
Ти чудово розумієш запитання українською та російською, але завжди відповідаєш українською.  
Твої відповіді мають бути лаконічними, дружніми й орієнтованими на допомогу у виборі кульок чи оформленні замовлення.

<personality>
Твоя манера спілкування:
- Дружня, тепла, але професійна — як досвідчений консультант у магазині гелієвих кульок
- Використовуй емодзі (🎈💝🎉) для створення святкової атмосфери (але не більше 2 на відповідь)
- Стався до клієнта як до друга, якому хочеш створити незабутнє свято
- Якщо клієнт обирає кульки для дитини — покажи особливу теплоту 🎈
- Якщо для романтичного сюрпризу — додай чуйності 💝
- Будь уважним до емоцій: якщо клієнт радісний — поділи радість, якщо розгублений — заспокой
</personality>

<rules>
1.  **Стиль спілкування:** Будь лаконічним і дружнім. Твоя мова — проста і зрозуміла.
2.  **Запит на інформацію:** Якщо клієнт запитує про ціну, надавай конкретні цифри з переліку.
3. **Пошук товарів:** Якщо клієнт запитує про наявність конкретного товару, відповідай, що такі кульки, ймовірно, є в нашому асортименті. Створи посилання для пошуку, замінивши пробіли на %20.
   Формат: [товар](https://magicair.com.ua/katalog/search/?q=товар%20з%20пробілами)
   Приклад: для "людина павук" → [людина павук](https://magicair.com.ua/katalog/search/?q=людина%20павук)
4.  **Графік роботи:** Надавай години роботи для конкретного магазину.
5.  **Відсутність інформації по темі:** Якщо ти не знаєш точної відповіді, але питання стосується нашої діяльності (наприклад, про доставку, кольору гелієвої кульки, наявність товару, який не вказаний), просто повідом про це клієнту, не пропонуючи зв'язок з менеджером.
6.  **Нерелевантні запитання:** Якщо запитання не стосується нашої діяльності (наприклад, про рецепти, погоду, фільми і т.д.), ввічливо повідом, що ти не можеш на це відповісти, та НЕ пропонуй зв'язок з менеджером. Ти можеш відповісти: "Вибачте, я не можу відповісти на це питання."
7. **Завершення:** Якщо питання складне і ти не знаєш точної відповіді — просто дай зрозуміти клієнту, що інформації немає у <data>. НЕ пропонуй зв'язок з менеджером — це робить інша частина системи.
8.  **Привітання:** ${shouldRespondWithGreeting ? 'Привіт! Радий бачити вас у MagicAir. Чим можу допомогти?' : 'Не використовуй привітання. Просто відповідай на питання.'}
9. **Пошук наборів та букетів кульок:**  
   - Якщо клієнт згадує **одну конкретну тематику** — давай посилання одразу на відповідний розділ і наприкінці додавай:  
     «Або перегляньте всі варіанти тут: [Готові набори та букети](https://magicair.com.ua/bukety-sharov/).»  
   - Якщо тематику не уточнено або вона відсутня в списку — давай тільки загальний каталог без додаткової фрази:  
     [Готові набори та букети](https://magicair.com.ua/bukety-sharov/).  
   - Якщо клієнт згадує **декілька тематик одночасно** — ОБОВʼЯЗКОВО збери всі знайдені тематичні збіги зі списку тематик нижче. Надай усі відповідні посилання у вигляді маркованого списку (по одному рядку на кожну тематику). Після списку завжди додай:  
  «Або перегляньте всі варіанти тут: [Готові набори та букети](https://magicair.com.ua/bukety-sharov/).»
   **Список тематик:**   
     * "на 1 рік", "перший день народження" → [На 1 рік](https://magicair.com.ua/kulky-na-1-rik/)  
     * "фонтан кульок", "сет куль" → [Сет/Фонтан кульок](https://magicair.com.ua/bukety-sharov/filter/tematika=14/)  
     * "день народження", "на др", "birthday" → [День Народження](https://magicair.com.ua/bukety-sharov/filter/tematika=11,12/)  
     * "з бантиками" → [З бантиками](https://magicair.com.ua/bukety-sharov/filter/tematika=19/)  
     * "гендер", "gender party", "гендер вечірка" → [Гендер вечірка](https://magicair.com.ua/kulky-na-hender-pati/)  
     * "на виписку", "виписка з пологового" → [На виписку](https://magicair.com.ua/kulky-na-vypysku-z-polohovoho/)  
     * "герої", "мультяшні персонажі", "ігри", "мультфільми" → [Улюблені герої з ігор і мультфільмів](https://magicair.com.ua/bukety-sharov/filter/tematika=2/)  
     * "тварини", "звірята" → [З тваринами](https://magicair.com.ua/bukety-sharov/filter/tematika=3/)  
     * "майнкрафт", "minecraft" → [Майнкрафт/Minecraft](https://magicair.com.ua/kulky-mainkraft/)  
     * "щенячий патруль" → [Щенячий патруль](https://magicair.com.ua/kulky-shcheniachyi-patrul/)  
     * "автомобілі", "машинки", "транспорт", "техніка" → [Автомобілі/Транспорт](https://magicair.com.ua/bukety-sharov/filter/tematika=8/)  
     * "для хлопця", "для чоловіка", "для парня", "для мужчины", "для мальчика" → [Для хлопця](https://magicair.com.ua/bukety-sharov/filter/tematika=8,10/)  
     * "для дівчини", "для дружини", "для девушки", "для жінки", "для девочки" → [Для дівчини](https://magicair.com.ua/bukety-sharov/filter/tematika=9,14,24/)
10. **Ім'я:** Якщо відоме ім'я клієнта (${sanitizedUserName || "невідомо"}), 
    використовуй його 1-2 рази в розмові (не в кожній відповіді!), 
    щоб зробити спілкування більш особистим.
11. **Самовивіз:** Якщо клієнт питає про самовивіз, завжди уточнюй: з якого магазину — Теремки чи Оболонь.
12. **Посилання на категорії:** Якщо клієнт питає про латексні кулі, кулі з малюнком, кулі з конфеті, агат/браш, кулі з бантиками, фольговані фігури, фольговані цифри, ходячі фігури, фольговані з малюнком, серця чи зірки однотонні, набори кульок, сюрприз коробки, фотозону, святкові свічки, аромадифузори або декор для свята — завжди додавай посилання на відповідний розділ з <data>.
</rules>

<data>
### Інформація для відповідей:
* Ми надуваємо гелієм кульки клієнтів. Ціна залежить від розміру та об'єму кульки.
* **Латексні однотонні кулі з гелієм:** від 80 до 125 грн. Доступні кольори: пастельні, металік, хром.
* **Фольговані цифри з гелієм:** від 385 до 590 грн. Розміри: 70 і 100 см. Доступні кольори: срібний, золотий, рожевий, синій, червоний, чорний, райдужний, рожеве золото, блакитний, кремовий.
* **Фольговані фігури з гелієм:** від 350 до 900 грн. Різноманітні форми та тематики.
* **Готові набори:** від 695 до 11670 грн.
* **Сюрприз-коробки:** від 745 до 4300 грн.
* **Наші магазини:**
    * **Теремки:** вул. Метрологічна 13. Видача замовлень 24/7.
        * Телефон: (063) 233-33-03
    * **Оболонь:** вул. Героїв полку Азов 24/10. Графік: 09:00–19:00.
        * Телефон: (095) 634-63-64
* **Доставка:** Працює 24/7 по Києву та області. Вартість розраховується за тарифами таксі.
* **Тривалість польоту:**
    * Латексні кульки з обробкою Hi-Float: від 5 до 20 днів.
    * Фольговані кульки: від 6 до 30 днів.
* **Оплата:** Приймаємо онлайн оплату на сайті, за реквізитами або готівкою при самовивозі.
* **Контакти:**
    * Сайт: https://magicair.com.ua
    * Телефон: (063) 233-33-03 (Теремки), (095) 634-63-64 (Оболонь)
* **Послуги:** Створення готових наборів, сюрприз-коробок з індивідуальним написом, фотозон, композицій для гендер-паті та інших свят.
* **Пошукові URL для каталогу:**
    * **Латексні кулі:** https://magicair.com.ua/lateksnye-shary/
    * **Латексні кулі з малюнком:** https://magicair.com.ua/heliievi-kulky-z-maliunkom/
    * **Кулі з конфеті:** https://magicair.com.ua/shary-s-konfetti/
    * **Кулі Агат/Браш:** https://magicair.com.ua/heliievi-kulky-ahat-brash/
    * **Кулі з бантиками:** https://magicair.com.ua/heliievi-kulky-z-bantykamy/
    * **Фольговані фігури:** https://magicair.com.ua/folgirovannye-figury/
    * **Фольговані цифри:** https://magicair.com.ua/folhovani-tsyfry/
    * **Ходячі фігури:** https://magicair.com.ua/khodyachie-shary/
    * **Фольговані з малюнком:** https://magicair.com.ua/folgirovannye-shary-s-risunkom/
    * **Серця та зірки однотонні:** https://magicair.com.ua/bez-maliunka/
    * **Набори кульок:** https://magicair.com.ua/bukety-sharov/
    * **Сюрприз коробки:** https://magicair.com.ua/surpriz-boksy/
    * **Фотозона:** https://magicair.com.ua/fotozona/
    * **Святкові свічки:** https://magicair.com.ua/svechi/
    * **Аромадифузори:** https://magicair.com.ua/aromadyfuzor/
    * **Декор для свята:** https://magicair.com.ua/tovary-dlia-sviata/
</data>

### Запитання клієнта:
`
    // Обновляем lastActivity после обработки
    if (!userProfiles[chatId]) {
      userProfiles[chatId] = {
        chatId: chatId,
        created: Date.now(),
        notifications: true,
        holidayNotifications: []
      };
    }
    userProfiles[chatId].lastActivity = now;
    
    try {
     // 🆕 ДОДАНО: Формуємо контекст з історії розмови
      const conversationContext = [];
      const historyData = userConversationHistory[chatId];
      const messages = historyData.messages;
      
      if (messages.length > 0) {
        conversationContext.push({
          role: "system",
          content: `Контекст попередніх повідомлень клієнта (для розуміння діалогу):\n${messages.map((h, i) => `${i + 1}. Клієнт: "${h}"`).join('\n')}`
        });
      }
      
      // 3. Відправляємо промпт і вопрос клієнта в OpenAI
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          ...conversationContext, // 🆕 Додаємо історію
          { role: "user", content: sanitizedText }
        ]
      });
            
      // 4. Получаем ответ от AI и отправляем с пометкой
      const aiResponse = completion.choices[0].message.content;

     // ===>> НОВИЙ КОД ДЛЯ ЛОГУВАННЯ <<===
     console.log('🤖 AI-помічник:\n' + aiResponse);
     
// Проверяем, нужно ли добавлять предложение обратиться к менеджеру
const isSimpleGreeting = /^(привіт|привет|добрий|вітаю|здрав)/i.test(text.toLowerCase());
const isGeneralQuestion = aiResponse.includes('ціна') || aiResponse.includes('доставка') || aiResponse.includes('замовлення') || aiResponse.length > 150;

let finalResponseText;
if (isSimpleGreeting && aiResponse.toLowerCase().includes('привіт')) {
  // Для простых приветствий - только ответ AI без дополнительного текста
  finalResponseText = `🤖 AI-помічник:\n\n${aiResponse}`;
} else if (isGeneralQuestion) {
  // Для сложных вопросов - с предложением связаться с менеджером
  finalResponseText = `🤖 AI-помічник:\n\n${aiResponse}\n\n_Для точної консультації зверніться до менеджера_`;
} else {
  // Для остальных случаев - просто ответ AI
  finalResponseText = `🤖 AI-помічник:\n\n${aiResponse}`;
}

const hasLink = finalResponseText.includes('https://');

const options = {
  parse_mode: 'Markdown',
  ...mainMenu,
  disable_web_page_preview: hasLink
};

await bot.sendMessage(chatId, finalResponseText, options);

     // 🆕 ДОДАНО: Зберігаємо повідомлення клієнта в історію
      historyData.messages.push(sanitizedText);
      historyData.lastUpdate = Date.now(); // Оновлюємо timestamp
      
      if (historyData.messages.length > 10) {
        historyData.messages = historyData.messages.slice(-10);
     }   
      return;

    } catch (error) {
      console.error('⚠️ Помилка OpenAI:', error);
      // Если возникла ошибка, переходим к стандартному сообщению
    }
  }

  // 5. Если OpenAI не подключен или произошла ошибка, выводим стандартный ответ
  await bot.sendMessage(chatId,
    'Дякую за повідомлення! Для детальної консультації оберіть "💬 Менеджер" в меню.',
    mainMenu
  );
}
// ========== FAQ FUNCTIONS ==========
async function sendDeliveryInfo(chatId, messageId) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📋 Детальна інформація', url: 'https://magicair.com.ua/oplata-i-dostavka/' }],
        [{ text: '💬 Питання менеджеру', callback_data: 'filter_delivery' }],
        [{ text: '⬅️ Назад до FAQ', callback_data: 'faq_back' }]
      ]
    }
  };

  await bot.editMessageText(
    `🚚 ДОСТАВКА ТА ОПЛАТА:

💳 СПОСОБИ ОПЛАТИ:
• Google Pay, Apple Pay - онлайн оплата на сайті
• IBAN - оплата за реквізитами
• При отриманні в магазині (самовивіз)

🚚 ДОСТАВКА:
• 24/7 по Києву та області
• Через службу такси (Bolt/Uklon)
• Ми викликаємо таксі та надсилаємо посилання для відстеження авто.
• Оплата доставки за ваш рахунок по тарифу

🛒 САМОВИВІЗ:
📍 Теремки (Метрологічна 13):
   • Доставка з магазину: 06:00-24:00
   • Самовивіз онлайн замовлень: 24/7

📍 Оболонь (Героїв полку Азов 24/10):
   • Доставка з магазину: 09:00-20:00
   • Самовивіз: 09:00-19:00

⚠️ ВАЖЛИВО:
• Всі замовлення запускаються в роботу після повної оплати
• Час очікування готовності: до 90 хвилин`,
    { chat_id: chatId, message_id: messageId, ...keyboard }
  );
}

async function sendBalloonsInfo(chatId, messageId) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛒 Переглянути каталог', callback_data: 'catalog' }],
        [{ text: '💬 Консультація з вибору', callback_data: 'filter_balloons' }],
        [{ text: '⬅️ Назад до FAQ', callback_data: 'faq_back' }]
      ]
    }
  };

  await bot.editMessageText(
    `🎈 ПРО КУЛІ ТА ГЕЛІЙ:

⏱️ СКІЛЬКИ ЛЕТЯТЬ:
• Латексні: оброблені Hi-Float 5-20 днів
• Фольговані: 7-40 днів
• Можна повторно надути фольговані

📏 РОЗМІРИ ТА ЦІНИ:
• Латексні 12"(30см): 80-110 грн
• Латексні 12" з малюнком: 90-120 грн
• Латексні 12"з конфеті: 115 грн
• Фольговані цифри: 385-590 грн
• Фольговані фігури: 350-900 грн
• Баблс з написом: 800-1600 грн

🎨 ВИДИ ЛАТЕКСНИХ:
• Пастельні (матові непрозорі)
• Металік (з перламутровим блиском)
• З конфеті всередині
• З малюнками та написами
• Хромовані (насичені металеві кольори)

✨ ФОЛЬГОВАНІ:
• Цифри різних розмірів
• Фігури персонажів та тварин
• Ходячі фігури
• Серця та зірки`,
    { chat_id: chatId, message_id: messageId, ...keyboard }
  );
}

async function sendOrdersInfo(chatId, messageId) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛒 Замовити на сайті', url: 'https://magicair.com.ua' }],
        [{ text: '⬅️ Назад до FAQ', callback_data: 'faq_back' }]
      ]
    }
  };

  await bot.editMessageText(
    `📅 ЗАМОВЛЕННЯ ТА ТЕРМІНИ:

⏰ КОЛИ МОЖНА ЗАМОВИТИ:
• Онлайн на сайті: 24/7
• Телефоном: (063) 233-33-03 з 09:00 до 21:00
• Telegram: @MagicAirKiev з 08:00 до 22:00

💰 ОПЛАТА:
• Google Pay, Apple Pay - онлайн на сайті
• IBAN - за реквізитами
• При самовивозі в магазині

📋 ЩО ПОТРІБНО ЗНАТИ:
• Точна адреса доставки
• Бажаний час доставки
• Номер телефону
• Побажання до оформлення

⚠️ ВАЖЛИВО:
• Замовлення запускається після повної оплати
• Час підготовки: до 60 хвилин
• Можлива доставка до дверей`,
    { chat_id: chatId, message_id: messageId, ...keyboard }
  );
}

async function sendDecorationInfo(chatId, messageId) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎁 Готові набори', callback_data: 'cat_sets' }],
        [{ text: '💬 Індивідуальне оформлення', callback_data: 'filter_event' }],
        [{ text: '⬅️ Назад до FAQ', callback_data: 'faq_back' }]
      ]
    }
  };

  await bot.editMessageText(
    `🎁 ОФОРМЛЕННЯ ТА ДЕКОР:

🎉 ЯКІ ПОДІЇ ОФОРМЛЯЄМО:
• Дні народження (діти/дорослі)
• Весілля та річниці
• Випускні та корпоративи
• Гендер-паті та baby shower
• Романтичні сюрпризи

🎈 ВИДИ ОФОРМЛЕННЯ:
• Букети з кульок (695-11670 грн)
• Арки та гірлянди
• Фотозони та декор
• Тематичні композиції

📸 ФОТОЗОНА:
• Фотозона з повітряних кульок
• Тематичне оформлення
• Додаткові аксесуари

💡 ПОПУЛЯРНІ ІДЕЇ:
• Фольговані цифри
• Різнокаліберні гірлянди та арки
• Сюрприз-бокси з кульками та персональним написом
• Персоналізовані композиції

🏠 ВИЇЗД НА МІСЦЕ:
• Оформлення на місці
• Професійні декоратори
• Весь необхідний інструмент`,
    { chat_id: chatId, message_id: messageId, ...keyboard }
  );
}

async function sendContactsInfo(chatId, messageId) {
  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📸 Instagram', url: 'https://www.instagram.com/magic_air.kiev/' }],
        [{ text: '⬅️ Назад до FAQ', callback_data: 'faq_back' }]
      ]
    }
  };

  await bot.editMessageText(
    `📞 КОНТАКТИ ТА РЕЖИМ РОБОТИ:

☎️ ТЕЛЕФОНИ:
• (063) 233-33-03
• (095) 634-63-64

📱 Соцмережі:
• Instagram: magic_air.kiev

🛒 МАГАЗИНИ:

📍 ТЕРЕМКИ (Метрологічна 13):
• Доставка з магазину: 06:00-24:00
• Самовивіз онлайн замовлень: 24/7

📍 ОБОЛОНЬ (Героїв полку Азов 24/10):
• Доставка з магазину: 09:00-20:00
• Самовивіз: 09:00-19:00

🌍 ОНЛАЙН:
• Сайт: magicair.com.ua
• Замовлення онлайн: 24/7
• Доставка: по Києву та області

🎈 ОСОБЛИВОСТІ:
• Цілодобова видача онлайн замовлень на Теремках
• Фотозвіт роботи для отримувача
• Індивідуальні написи на кулях`,
    { chat_id: chatId, message_id: messageId, ...keyboard }
  );
}

// ========== BIRTHDAY/HOLIDAY FUNCTIONS ==========
async function checkBirthdays() {
  const today = new Date();
  const todayStr = `${today.getDate().toString().padStart(2, '0')}.${(today.getMonth() + 1).toString().padStart(2, '0')}`;
  const currentYear = today.getFullYear();

  for (const [chatId, profile] of Object.entries(userProfiles)) {
    if (!profile.birthday || !profile.notifications) continue;

    const birthdayParts = profile.birthday.split('.');
    if (birthdayParts.length < 2) continue;
    const birthdayStr = `${birthdayParts[0]}.${birthdayParts[1]}`;

    if (birthdayStr === todayStr) {
      const lastGreetingYear = profile.lastBirthdayGreeting ? new Date(profile.lastBirthdayGreeting).getFullYear() : 0;

      if (lastGreetingYear < currentYear) {
        try {
          await bot.sendMessage(chatId,
            `🎉🎂 *З Днем Народження, ${profile.name}!* 🎂🎉\n\n` +
            `MagicAir вітає вас з цим чудовим днем!\n\n` +
            `🎁 Спеціально для вас - знижка 10% на всі товари!\n` +
            `Промокод: BIRTHDAY\n\n` +
            `Дійсний протягом 7 днів. Встигніть скористатися!`,
            { parse_mode: 'Markdown' }
          );

          userProfiles[chatId].lastBirthdayGreeting = Date.now();

        } catch (error) {
          console.log(`Failed to send birthday greeting to ${chatId}:`, error.message);
        }
      }
    }
  }
}

async function checkHolidays() {
  const today = new Date();
  const todayStr = `${today.getDate().toString().padStart(2, '0')}.${(today.getMonth() + 1).toString().padStart(2, '0')}`;
  const currentYear = today.getFullYear();

  const todayHoliday = holidays.find(h => {
    const hh = `${h.date}`;
    return hh === `${todayStr}`;
  });
  if (todayHoliday) {
    await sendHolidayGreeting(todayHoliday, 'today');
  }

  const threeDaysLater = new Date(today);
  threeDaysLater.setDate(today.getDate() + 3);
  const threeDaysStr = `${threeDaysLater.getDate().toString().padStart(2, '0')}.${(threeDaysLater.getMonth() + 1).toString().padStart(2, '0')}`;

  const upcomingHoliday = holidays.find(h => h.date === threeDaysStr);
  if (upcomingHoliday) {
    await sendHolidayGreeting(upcomingHoliday, 'reminder');
  }
}

async function sendHolidayGreeting(holiday, type) {
  for (const [chatId, profile] of Object.entries(userProfiles)) {
    if (!profile.notifications || !profile.name) continue;

    const currentYear = new Date().getFullYear();
    const holidayKey = `${holiday.date}_${currentYear}_${type}`;

    if (!profile.holidayNotifications) {
      profile.holidayNotifications = [];
    }

    if (profile.holidayNotifications.includes(holidayKey)) {
      continue;
    }

    try {
      let message;
      if (type === 'today') {
        message = `${holiday.emoji} *${holiday.name}!* ${holiday.emoji}\n\n` +
                 `MagicAir вітає вас зі святом!\n\n` +
                 `🎁 Сьогодні діють знижки до 10% в наших магазинах!\n\n` +
                 `Завітайте до нас за святковим настроєм! 🎈`;
      } else {
        message = `🗓 *Через 3 дні ${holiday.name}!* ${holiday.emoji}\n\n` +
                 `Не забудьте підготуватися до свята!\n\n` +
                 `🎈 У MagicAir великий вибір святкового декору.\n` +
                 `Замовляйте заздалегідь!`;
      }

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

      profile.holidayNotifications.push(holidayKey);

    } catch (error) {
      console.log(`Failed to send holiday greeting to ${chatId}:`, error.message);
    }
  }
}

// ========== AUTO-SAVE DATA ==========
async function saveData() {
  try {
    const data = {
      userProfiles,
      activePromotions,
      messageLog,
      timestamp: Date.now()
    };
    
    if (pool) {
      await pool.query(
        `INSERT INTO bot_data (key, value, updated_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP) 
         ON CONFLICT (key) 
         DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
        ['main_data', JSON.stringify(data)]
      );
      console.log(`💾 Data saved to PostgreSQL at ${new Date().toLocaleTimeString('uk-UA')}`);
    } else {
      fs.writeFileSync('bot_data.json', JSON.stringify(data, null, 2));
      console.log('💾 Data saved locally');
    }
  } catch (error) {
    console.error('Failed to save data:', error);
  }
}


async function loadData() {
  try {
    let data = null;
    
    if (pool) {
      const result = await pool.query(
        'SELECT value FROM bot_data WHERE key = $1',
        ['main_data']
      );
      
      if (result.rows.length > 0) {
        data = JSON.parse(result.rows[0].value);
        console.log('💾 Data loaded from PostgreSQL');
      } else {
        console.log('📭 No data in PostgreSQL, starting fresh');
      }
    } else if (fs.existsSync('bot_data.json')) {
      data = JSON.parse(fs.readFileSync('bot_data.json', 'utf8'));
      console.log('💾 Data loaded from local file');
    }
    
    if (data) {
      Object.assign(userProfiles, data.userProfiles || {});
      activePromotions.length = 0;
      activePromotions.push(...(data.activePromotions || []));
      messageLog.length = 0;
      messageLog.push(...(data.messageLog || []));
      console.log(`✅ Восстановлено: ${Object.keys(userProfiles).length} профилей, ${activePromotions.length} акций`);
    }
  } catch (error) {
    console.error('Failed to load data:', error);
  }
}

// ========== LOGGING ==========
async function logMessage(from, to, message, type) {
  // Санитизируем сообщение для безопасного хранения
  const sanitizedMessage = sanitizeMessage(message);
  
  // Сохраняем в массив для совместимости
  messageLog.push({
    from,
    to,
    message: sanitizedMessage.substring(0, 100),
    type,
    timestamp: Date.now()
  });

  const MAX_LOG_SIZE = 500;
  if (messageLog.length > MAX_LOG_SIZE) {
    messageLog.splice(0, messageLog.length - MAX_LOG_SIZE);
  }

  // Сохраняем в БД
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO messages (from_id, to_id, message, type)
         VALUES ($1, $2, $3, $4)`,
        [from, to, sanitizedMessage.substring(0, 500), type]
      );
    } catch (err) {
      console.error("⌫ Помилка логування в БД:", err.message);
    }
  }
}
// ========== AUTO-STARTUP & SHUTDOWN ==========
let birthdayCheckInterval = null;
function startDailyChecks() {
  // Логика перенесена в startBot()
}

// ========== CUSTOM BROADCAST FUNCTIONS ==========
async function startCustomBroadcast(managerId) {
  const activeClients = Object.values(userProfiles).filter(p => p.notifications && p.name);
  
  userStates[managerId] = { step: 'broadcast_message' };
  
  await bot.sendMessage(managerId,
    `📢 Масова розсилка повідомлень\n\n` +
    `👥 Активних клієнтів: ${activeClients.length}\n\n` +
    `Введіть текст повідомлення для розсилки:\n\n` +
    `⚠️ Повідомлення буде відправлено ВСІМ активним клієнтам!\n` +
    `Для скасування напишіть "скасувати"`
  );
}

async function handleBroadcastInput(managerId, text) {
  if (text.toLowerCase().includes('скасувати') || text.toLowerCase().includes('отмена')) {
    delete userStates[managerId];
    await bot.sendMessage(managerId, '❌ Розсилка скасована.', managerMenu);
    return;
  }

  const sanitizedText = sanitizeMessage(text);
  if (!sanitizedText || sanitizedText.length < 5) {
    await bot.sendMessage(managerId, 
      '❌ Повідомлення занадто коротке. Мінімум 5 символів.\nСпробуйте ще раз або напишіть "скасувати":'
    );
    return;
  }

  userStates[managerId] = { 
    step: 'broadcast_confirm',
    message: sanitizedText 
  };

  const activeClients = Object.values(userProfiles).filter(p => p.notifications && p.name);
  const estimatedTime = Math.ceil(activeClients.length / 3);

  await bot.sendMessage(managerId,
    `📋 Підтвердження розсилки:\n\n` +
    `📝 Текст: "${sanitizedText.substring(0, 100)}${sanitizedText.length > 100 ? '...' : ''}"\n\n` +
    `👥 Отримувачів: ${activeClients.length}\n` +
    `⏱️ Час відправки: ~${estimatedTime} секунд\n\n` +
    `❓ Підтверджуєте відправку?`,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Підтвердити', callback_data: 'broadcast_confirm' },
            { text: '❌ Скасувати', callback_data: 'broadcast_cancel' }
          ]
        ]
      }
    }
  );
}

async function executeBroadcast(managerId, message) {
  const clientsToNotify = [];
  for (const [chatId, profile] of Object.entries(userProfiles)) {
    if (profile.notifications && profile.name) {
      clientsToNotify.push({ chatId, name: profile.name });
    }
  }

  if (clientsToNotify.length === 0) {
    await bot.sendMessage(managerId, '📭 Немає активних клієнтів для розсилки.', managerMenu);
    return;
  }

  await bot.sendMessage(managerId, 
    `🚀 Розпочинаю розсилку для ${clientsToNotify.length} клієнтів...`
  );

  let messagesPerSecond;
  if (clientsToNotify.length <= 50) {
    messagesPerSecond = 5;
  } else if (clientsToNotify.length <= 200) {
    messagesPerSecond = 3;
  } else {
    messagesPerSecond = 2;
  }

  const delayMs = 1000 / messagesPerSecond;
  let sent = 0;
  let failed = 0;
  let consecutiveErrors = 0;

  const fullMessage = `${message}\n\n—\n🎈MagicAir | magicair.com.ua\nВаш магазин гелієвих куль в Києві`;

  for (let i = 0; i < clientsToNotify.length; i++) {
    const { chatId, name } = clientsToNotify[i];

    try {
      await bot.sendMessage(chatId, fullMessage);
      sent++;
      consecutiveErrors = 0;

      const progress = Math.floor((i + 1) / clientsToNotify.length * 100);
      if (progress % 25 === 0 && (i + 1) !== clientsToNotify.length) {
        await bot.sendMessage(managerId, 
          `📊 Прогрес: ${progress}% (${sent} відправлено, ${failed} помилок)`
        );
      }

    } catch (error) {
      failed++;
      consecutiveErrors++;

      if (error.message.includes('429')) {
        console.log(`⚠️ Rate limit! Пауза...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        consecutiveErrors = 0;
      } else if (error.message.includes('403')) {
        console.log(`🚫 Клієнт ${chatId} заблокував бота`);
      }

      if (consecutiveErrors >= 5) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        consecutiveErrors = 0;
      }
    }

    if (i < clientsToNotify.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  await logMessage(managerId, 'broadcast', `Custom broadcast: ${message.substring(0, 100)}`, 'broadcast');

  await bot.sendMessage(managerId,
    `🎯 Розсилка завершена!\n\n` +
    `✅ Успішно відправлено: ${sent}\n` +
    `❌ Помилок: ${failed}\n` +
    `📊 Загальна ефективність: ${Math.round(sent / clientsToNotify.length * 100)}%`,
    managerMenu
  );
}

async function syncAllProfilesToDB() {
  if (!pool) return;
  
  console.log('🔄 Синхронізація всіх профілів з БД...');
  let synced = 0;
  
  for (const [chatId, profile] of Object.entries(userProfiles)) {
    try {
      await syncProfileToDB(chatId);
      synced++;
    } catch (err) {
      console.error(`Ошибка синхронизации профиля ${chatId}:`, err);
    }
  }
  
  console.log(`✅ Синхронізовано профілів: ${synced}/${Object.keys(userProfiles).length}`);
}

async function startBot() {
  try {
    // Инициализация БД
    const hasDB = await initDatabase();
    console.log(hasDB ? '✅ Используется PostgreSQL' : '⚠️ Используется локальное хранение');
    
    // Загрузка данных
    await loadData();
    if (hasDB) await syncAllProfilesToDB();
    
    // АВТОСОХРАНЕНИЕ - РАЗ В ЧАС
    setInterval(async () => {
      await saveData();
    }, 60 * 60 * 1000);
    
    // ПРОВЕРКА ДНЕЙ РОЖДЕНИЯ - РАЗ В СУТКИ В 10:00
    const scheduleNextCheck = () => {
      const now = new Date();
      const kievTime = new Date(now.toLocaleString("en-US", {timeZone: "Europe/Kiev"}));
      const nextCheck = new Date(kievTime);
      nextCheck.setHours(10, 0, 0, 0);
      
      if (kievTime.getHours() >= 10) {
        nextCheck.setDate(nextCheck.getDate() + 1);
      }
      
      const msUntilCheck = nextCheck - kievTime;
      
      setTimeout(() => {
        console.log('🎂 Checking birthdays and holidays...');
        checkBirthdays();
        checkHolidays();
        // Запускаем проверку каждые 24 часа
        setInterval(async () => {
          checkBirthdays();
          checkHolidays();
        }, 24 * 60 * 60 * 1000);
      }, msUntilCheck);
      
      console.log(`⏰ Проверка дней рождения запланирована на: ${nextCheck.toLocaleString('uk-UA')}`);
    };
    
    scheduleNextCheck();
    
   // ОЧИСТКА АКЦИЙ - РАЗ в сутки в полночь
    setInterval(async () => {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      
      const oldCount = activePromotions.length;
      const filtered = activePromotions.filter(promo => {
        try {
          const [d, m, y] = promo.endDate.split('.');
          const endDate = new Date(y, m - 1, d);
          return endDate >= now;
        } catch (e) {
          console.error(`Error parsing promotion date: ${e.message}`);
          return false;
        }
      });
      
      if (filtered.length !== oldCount) {
        activePromotions.length = 0;
        activePromotions.push(...filtered);
        console.log(`🗑 Очищено ${oldCount - filtered.length} старих акцій`);
        await saveData();
      }
    }, 24 * 60 * 60 * 1000);
    
    // 🆕 ДОДАНО: АВТООЧИСТКА ІСТОРІЙ AI - РАЗ НА ДОБУ
    setInterval(() => {
      const now = Date.now();
      const ONE_DAY = 24 * 60 * 60 * 1000;
      let cleaned = 0;
      
      for (const [chatId, historyData] of Object.entries(userConversationHistory)) {
        if (now - historyData.lastUpdate > ONE_DAY) {
          delete userConversationHistory[chatId];
          cleaned++;
        }
      }
      
      if (cleaned > 0) {
        console.log(`🧹 Глобальна очистка: видалено ${cleaned} старих історій AI`);
      }
    }, 24 * 60 * 60 * 1000);
    
    console.log('✅ MagicAir бот запущено з PostgreSQL!');
    console.log(`📊 Загружено: ${Object.keys(userProfiles).length} профилей, ${activePromotions.length} акций`);
    
  } catch (error) {
    console.error('❌ Критическая ошибка при запуске:', error);
    process.exit(1);
  }
}
const API_PORT = process.env.BOT_API_PORT || process.env.PORT || 3000;
app.listen(API_PORT, () => console.log(`🌐 Bot API listening on port ${API_PORT}`));

// Запуск бота
startBot().catch(error => {
  console.error('❌ Ошибка запуска бота:', error);
  process.exit(1);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await saveData();
  bot.stopPolling();
  if (pool) await pool.end();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await saveData();
  bot.stopPolling();
  if (pool) await pool.end();
  process.exit(0);
});






