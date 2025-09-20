// magicair-bot-full.js
process.env["NTBA_FIX_319"] = 1;
process.env["NTBA_FIX_350"] = 1;

const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require('openai');
const fs = require('fs');
const { Pool } = require('pg');

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
  : [7764495189,5106454153, /* третій ID */];

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
const activePromotions = [];
const holidays = [
  { date: '14.02', name: 'День Святого Валентина', emoji: '💕' },
  { date: '08.03', name: 'Міжнародний жіночий день', emoji: '🌸' },
  { date: '01.01', name: 'Новий рік', emoji: '🎊' },
  { date: '25.12', name: 'Різдво', emoji: '🎄' },
  { date: '31.10', name: 'Хелловін', emoji: '🎃' }
];

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
      ['📊 Статистика', '🛑 Завершити чат']
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
  const firstName = msg.from.first_name || 'друже';
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
        `🎈 Привіт, ${firstName}!\n\nВітаємо в MagicAir - магазин гелієвих кульок в Києві 🎉\n\nОберіть опцію з меню:`,
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
  const text = msg.text || '';
  const userName = msg.from.first_name || 'Клієнт';

  if (text && text.startsWith('/')) {
    if (text === '/end') {
      await handleEndCommand(chatId);
    }
    return;
  }

  console.log(`📨 ${chatId} (${userName}): ${text}`);

  try {
    if (isManager(chatId)) {
      await handleManagerMessage(msg);
    } else {
      await handleClientMessage(msg);
    }
  } catch (error) {
      console.error('⚠ Message error:', error);
      await bot.sendMessage(chatId, '⚠ Помилка. Спробуйте /start').catch(() => {});
  }
});

// ========== CLIENT HANDLER ==========
async function handleClientMessage(msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const userName = msg.from.first_name || 'Клієнт';

  if (userProfiles[chatId]) userProfiles[chatId].lastActivity = Date.now();

  // Проверяем, находится ли клиент в активном чате с менеджером
  if (userStates[chatId]?.step === 'manager_chat') {
    // Если клиент прислал "Главное меню", завершаем чат
    if (text === '🏠 Головне меню') {
      await handleEndCommand(chatId);
      return;
    }
    // В противном случае, пересылаем сообщение менеджеру
    await forwardToManager(chatId, text, userName);
    return;
  }

  switch (text) {
    case '🛒 Каталог':
      await bot.sendMessage(chatId, '🛒 Каталог товарів MagicAir:\n\nОберіть категорію:', catalogMenu); return;
    case '❓ FAQ':
      await sendInteractiveFAQ(chatId); return;
    case '📱 Сайт':
      await bot.sendMessage(chatId,
        '🌍 Наш сайт:\n👉 https://magicair.com.ua\n\n🛒 Тут ви можете переглянути повний каталог та оформити замовлення!',
        { reply_markup: { inline_keyboard: [
            [{ text: '🛒 Відкрити сайт', url: 'https://magicair.com.ua' }],
            [{ text: '🏠 Головне меню', callback_data: 'main_menu' }]
        ]}}
      ); return;
    case '📞 Контакти':
      await sendContacts(chatId); return;
    case '🔍 Пошук':
      userStates[chatId] = { step: 'search' };
      await bot.sendMessage(chatId, '🔍 Введіть назву товару для пошуку:'); return;
    case '💬 Менеджер':
      // ИСПОЛЬЗУЕМ НОВУЮ ФУНКЦИЮ ПРОВЕРКИ ВРЕМЕНИ
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
      await showProfile(chatId); return;
  }

  if (userStates[chatId]?.step?.startsWith('profile_')) {
    await handleProfileInput(chatId, text, userStates[chatId].step);
    return;
  }
  if (userStates[chatId]?.step === 'search') {
    await handleSearch(chatId, text);
    delete userStates[chatId];
    return;
  }

  await handleGeneralMessage(chatId, text, userName);
}

// ========== MANAGER HANDLER ==========
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
    await bot.sendMessage(clientId, `👨‍💼 ${getManagerName(managerId)}: ${text}`);
    await logMessage(managerId, clientId, text, 'manager');
    return;
  }

  switch (text) {
    case '📋 Клієнти':
      await showClientsList(managerId);
      break;
    case '🎁 Активні акції':
      await showPromotionsList(managerId);
      break;
   case '📄 Журнал':
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
      await endManagerChat(managerId);
      break;
    case '📊 Статистика':
      await showStats(managerId);
      break;
    case '🎁 Створити акцію':
      await startPromotionCreation(managerId);
      break;
    default:
      if (!activeManagerChats[managerId]) {
        await bot.sendMessage(managerId, '👨‍💼 Будь ласка, оберіть дію з меню.');
      }
      break;
  }
  // Обработка поиска истории
  if (userStates[managerId]?.step === 'search_history') {
    await searchClientHistory(managerId, text.trim());
    delete userStates[managerId];
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

async function startManagerChatWithClient(managerId, clientId) {
  if (activeManagerChats[managerId]) {
    await bot.sendMessage(managerId, '🛑 Ви вже в активному чаті. Завершіть його, щоб підключитися до іншого.');
    return;
  }

  if (!waitingClients.has(clientId)) {
    await bot.sendMessage(managerId, 'Клієнт уже не в черзі або його запит скасовано.');
    return;
  }

  const managerName = getManagerName(managerId);

  activeManagerChats[managerId] = clientId;
  userStates[clientId] = { step: 'manager_chat', managerId: managerId };
  waitingClients.delete(clientId);

  await bot.sendMessage(managerId, `✅ Ви підключені до клієнта (${clientId}).`);
  
  // ИЗМЕНЁННАЯ СТРОКА: добавлено "Менеджер"
  await bot.sendMessage(clientId, `👨‍💼 Менеджер ${managerName} підключився до чату!\nВін радий відповісти на ваші запитання.`, clientInChatMenu);

  const welcomeMessage = 'Чим можу вам допомогти?';
  await bot.sendMessage(clientId, `👨‍💼 ${managerName}: ${welcomeMessage}`);
  await logMessage(managerId, clientId, welcomeMessage, 'manager');
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
    '📝 Давайте заповнимо ваш профіль!\n\nКрок 1/3: Як вас звати?'
  );
}

async function handleProfileInput(chatId, text, step) {
  if (!userProfiles[chatId]) {
    userProfiles[chatId] = {
      created: Date.now(),
      notifications: true,
      holidayNotifications: []
    };
  }
  switch (step) {
    case 'profile_name':
      userProfiles[chatId].name = text;
      userStates[chatId].step = 'profile_phone';
      await bot.sendMessage(chatId,
        '📞 Крок 2/3: Введіть ваш номер телефону:\n(формат: +380XXXXXXXXX)'
      );
      break;
    case 'profile_phone':
      const phoneRegex = /^(\+380|380|0)?[0-9]{9}$/;
      if (!phoneRegex.test(text.replace(/[\s\-\(\)]/g, ''))) {
        await bot.sendMessage(chatId,
          '❌ Невірний формат номера.\nСпробуйте ще раз (приклад: +380501234567):'
        );
        return;
      }
      userProfiles[chatId].phone = text;
      userStates[chatId].step = 'profile_birthday';
      await bot.sendMessage(chatId,
        '🎂 Крок 3/3: Введіть дату вашого народження:\n(формат: ДД.MM.YYYY, приклад: 15.03.1990)'
      );
      break;
    case 'profile_birthday': {
      const dateRegex = /^(\d{2})\.(\d{2})\.(\d{4})$/;
      if (!dateRegex.test(text)) {
        await bot.sendMessage(chatId,
          '❌ Невірний формат дати.\nСпробуйте ще раз (приклад: 15.03.1990):'
        );
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
      userProfiles[chatId].birthday = text;
     userProfiles[chatId].birthday_changed_at = Date.now();
      delete userStates[chatId];
      await saveData(); // 💾 Сохраняем профиль сразу!
      await syncProfileToDB(chatId); // 🆕 Синхронизируем с БД!
      await bot.sendMessage(chatId,
        '✅ Профіль успішно створено!\n\nТепер ви будете отримувати:\n• 🎁 Персональні знижки\n• 🎂 Вітання з днем народження\n• 🎊 Спеціальні пропозиції до свят',
        mainMenu
      );
      break;
    }
  }
}
// ========== СИНХРОНИЗАЦИЯ ПРОФИЛЕЙ С БД ==========
async function syncProfileToDB(chatId) {
  // ... весь код из пункта 3 ...
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
  let notifiedCount = 0;
  for (const [chatId, profile] of Object.entries(userProfiles)) {
    if (profile.notifications && profile.name) {
      try {
        await bot.sendMessage(chatId,
          `🎁 *Нова акція в MagicAir!*\n\n${promo.title}\n\n${promo.description}\n\n⏰ Діє до: ${promo.endDate}\n\n🛒 Встигніть скористатися!`,
          { parse_mode: 'Markdown' }
        );
        notifiedCount++;
      } catch (error) {
        console.log(`Failed to notify ${chatId}:`, error.message);
      }
    }
  }
  console.log(`✅ Notified ${notifiedCount} clients about new promotion`);
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
  await bot.sendMessage(chatId, '🔍 Шукаємо...');

  const searchUrl = `https://magicair.com.ua/katalog/search/?q=${encodeURIComponent(query)}`;

  await bot.sendMessage(chatId,
    `🔍 Результати пошуку "${query}":`,
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

// ========== ИСПРАВЛЕННЫЕ ФУНКЦИИ МЕНЕДЖЕРА ==========
async function forwardToManager(clientId, text, userName) {
  const managerId = userStates[clientId]?.managerId;
  const managerName = getManagerName(managerId);
  if (managerId && activeManagerChats[managerId] === clientId) {
    await bot.sendMessage(managerId, `👤 ${userName} (${clientId}): ${text}`);
    await logMessage(clientId, managerId, text, 'client');
  } else {
    await bot.sendMessage(clientId, '⚠ З\'єднання з менеджером втрачено. Спробуйте ще раз.', mainMenu);
    delete userStates[clientId];
  }
}

async function forwardToClient(clientId, text) {
  const managerId = userStates[clientId]?.managerId;
  const managerName = getManagerName(managerId);
  await bot.sendMessage(clientId, `👨‍💼 ${managerName}: ${text}`);
}

async function handleEndCommand(chatId) {
  if (userStates[chatId]?.step === 'manager_chat') {
    const managerId = userStates[chatId].managerId;
    const managerName = getManagerName(managerId);
    if (activeManagerChats[managerId] === chatId) {
      delete activeManagerChats[managerId];
      await bot.sendMessage(managerId, `✅ Клієнт завершив чат.`, managerMenu);
    }
    delete userStates[chatId];
    await bot.sendMessage(chatId, '✅ Чат завершено.', mainMenu);
  } else if (isManager(chatId)) {
    await endManagerChat(chatId);
  }
}

async function endManagerChat(managerId) {
  const clientId = activeManagerChats[managerId];
  if (clientId) {
    delete activeManagerChats[managerId];
    delete userStates[clientId];
    await bot.sendMessage(clientId, '✅ Менеджер завершив чат.', mainMenu);
  }
  await bot.sendMessage(managerId, '✅ Чат завершено.', managerMenu);
}
// ========== ФУНКЦИИ ИСТОРИИ СООБЩЕНИЙ ==========
// ========== ФУНКЦИИ ИСТОРИИ СООБЩЕНИЙ ==========
async function searchClientHistory(managerId, query) {
  if (!pool) {
    bot.sendMessage(managerId, '⚠️ База даних недоступна');
    return;
  }

  try {
    // Ищем в профилях
    const profileRes = await pool.query(
      `SELECT chat_id, name, phone FROM profiles
       WHERE CAST(chat_id AS TEXT) ILIKE $1
          OR name ILIKE $1
          OR phone ILIKE $1
       LIMIT 5`,
      [`%${query}%`]
    );

    if (profileRes.rows.length === 0) {
      await bot.sendMessage(managerId, '❌ Клієнта не знайдено.\nСпробуйте ввести ID, ім\'я або телефон.');
      return;
    }

    if (profileRes.rows.length === 1) {
      await sendClientHistory(managerId, profileRes.rows[0].chat_id, 0);
      return;
    }

    let text = '📋 Знайдено клієнтів:\n\n';
    const buttons = [];

    for (const profile of profileRes.rows) {
      text += `👤 ${profile.name || 'Без імені'}\n🆔 ${profile.chat_id}\n`;
      if (profile.phone) text += `📞 ${profile.phone}\n`;
      text += '\n';
      buttons.push([{
        text: `${profile.name || profile.chat_id}`,
        callback_data: `show_history_${profile.chat_id}_0`
      }]);
    }

    await bot.sendMessage(managerId, text, {
      reply_markup: { inline_keyboard: buttons }
    });

  } catch (err) {
    console.error("❌ Помилка searchClientHistory:", err);
    bot.sendMessage(managerId, '⚠️ Помилка при пошуку історії.');
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
      callback_data: `client_chat_${clientId}`
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
  // Эта функция будет вызываться, когда клиент отправляет любой текст,
  // который не является командой или частью диалога с менеджером.

  // 1. Проверяем, есть ли подключение к OpenAI
  if (openai) {
    const userProfile = userProfiles[chatId] || {};
    const now = Date.now();
    const lastActivity = userProfile.lastActivity || 0;
    const timeSinceLastMessage = now - lastActivity;

    const greetingThreshold = 5 * 60 * 60 * 1000; // 5 часов в миллисекундах
    const shouldGreet = timeSinceLastMessage > greetingThreshold;
    
    // Проверяем, содержит ли сообщение приветствие
    const greetingWords = ['привіт', 'привет', 'добрий день', 'добрий ранок', 'добрий вечір', 'здравствуй', 'вітаю', 'доброго дня', 'добрый день'];
    const messageContainsGreeting = greetingWords.some(word =>
      text.toLowerCase().includes(word)
    );
    
    // Определяем, нужно ли приветствовать
    const shouldRespondWithGreeting = shouldGreet || messageContainsGreeting;
    
 // 2. Створюємо промпт з інструкціями для AI
const systemPrompt = `
Ти — розумний та надзвичайно привітний помічник магазину повітряних кульок "MagicAir".
Твоя мета — допомагати клієнтам, відповідаючи на їхні запитання швидко, ввічливо і професійно, використовуючи лише надану інформацію.
Ти розумієш запитання українською та російською мовами, але відповідаєш тільки українською.

<rules>
1.  **Стиль спілкування:** Будь лаконічним і дружнім. Твоя мова — проста і зрозуміла.
2.  **Запит на інформацію:** Якщо клієнт запитує про ціну, надавай конкретні цифри з переліку.
3. **Пошук товарів:** Якщо клієнт запитує про наявність конкретного товару, відповідай, що такі кульки, ймовірно, є в нашому асортименті. Створи посилання для пошуку, замінивши пробіли на %20.
   Формат: [товар](https://magicair.com.ua/katalog/search/?q=товар%20з%20пробілами)
   Приклад: для "людина павук" → [людина павук](https://magicair.com.ua/katalog/search/?q=людина%20павук)
4.  **Графік роботи:** Надавай години роботи для конкретного магазину.
5.  **Відсутність інформації по темі:** Якщо ти не знаєш точної відповіді, але питання стосується нашої діяльності (наприклад, про доставку, кольору гелієвої кульки, наявність товару, який не вказаний), просто повідом про це клієнту, не пропонуючи зв'язок з менеджером.
6.  **Нерелевантні запитання:** Якщо запитання не стосується нашої діяльності (наприклад, про рецепти, погоду, фільми і т.д.), ввічливо повідом, що ти не можеш на це відповісти, та НЕ пропонуй зв'язок з менеджером. Ти можеш відповісти: "Вибачте, я не можу відповісти на це питання."
7.  **Завершення:** Після відповіді на складне питання, завжди пропонуй консультацію менеджера, щоб клієнт міг отримати повну інформацію.
8.  **Привітання:** ${shouldRespondWithGreeting ? 'Привіт! Радий бачити вас у MagicAir. Чим можу допомогти?' : 'Не використовуй привітання. Просто відповідай на питання.'}
9. **Пошук наборів та букетів:** Якщо клієнт запитує про готові набори кульок або букети для дівчинки/хлопчика, надавай посилання на каталог, де зібрані букети та набори. Використовуй посилання у форматі Markdown: [Готові набори та букети](https://magicair.com.ua/bukety-sharov/).
</rules>

<data>
### Інформація для відповідей:
* Ми надуваємо гелієм кульки клієнтів. Ціна залежить від розміру та об'єму кульки.
* **Латексні однотонні кулі з гелієм:** від 80 до 125 грн. Доступні кольори: пастельні, металік, хром.
* **Фольговані цифри з гелієм:** від 385 до 590 грн. Розміри: 70 і 100 см. Доступні кольори: срібний, золотий, рожевий, синій, червоний, чорний, райдужний, рожеве золото, блакитний, кремовий.
* **Фольговані фігури з гелієм:** від 350 до 900 грн. Різноманітні форми та тематики.
* **Готові набори:** від 695 до 11670 грн.
* **Сюрприз-коробки:** від 745 до 4300 грн.
* **Сайт:** https://magicair.com.ua
* **Наші магазини:**
    * **Теремки:** вул. Метрологічна 13. Видача замовлень 24/7.
    * **Оболонь:** вул. Героїв полку Азов 24/10. Графік: 09:00-19:00.
* **Доставка:** Працює 24/7 по Києву та області. Вартість розраховується за тарифами таксі.
* **Тривалість польоту:**
    * Латексні кульки з обробкою Hi-Float: від 5 до 20 днів.
    * Фольговані кульки: від 6 до 30 днів.
* **Оплата:** Приймаємо онлайн, за реквізитами або готівкою при самовивозі.
* **Контакти:** (063) 233-33-03.
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
        created: Date.now(),
        notifications: true,
        holidayNotifications: []
      };
    }
    userProfiles[chatId].lastActivity = now;
    
    try {
      // 3. Отправляем промпт и вопрос клиента в OpenAI
      const completion = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: text }
        ]
      });
      
      
      // 4. Получаем ответ от AI и отправляем с пометкой
      const aiResponse = completion.choices[0].message.content;

     // ===>> НОВИЙ КОД ДЛЯ ЛОГУВАННЯ <<===
     console.log('🤖 AI-помічник:\n' + aiResponse);
     
    // ===>> ИСПРАВЛЕННЫЙ БЛОК <<===
    const finalResponseText = `🤖 AI-помічник:\n\n${aiResponse}\n\n_Для точної консультації зверніться до менеджера_`;
    const hasLink = aiResponse.includes('https://') || finalResponseText.includes('https://');
      
      const options = {
        parse_mode: 'Markdown',
        ...mainMenu,
        disable_web_page_preview: hasLink
      };

      await bot.sendMessage(chatId, finalResponseText, options);
      // ===>> КОНЕЦ ИСПРАВЛЕННОГО БЛОКА <<===
      
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
  // Сохраняем в массив для совместимости
  messageLog.push({
    from,
    to,
    message: message.substring(0, 100),
    type,
    timestamp: Date.now()
  });

  const MAX_LOG_SIZE = 500;
  if (messageLog.length > MAX_LOG_SIZE) {
    messageLog.splice(0, messageLog.length - MAX_LOG_SIZE);
  }

  // 🆕 СОХРАНЯЕМ В БД
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO messages (from_id, to_id, message, type)
         VALUES ($1, $2, $3, $4)`,
        [from, to, message.substring(0, 500), type]
      );
    } catch (err) {
      console.error("❌ Ошибка логирования в БД:", err.message);
    }
  }
}
// ========== AUTO-STARTUP & SHUTDOWN ==========
let birthdayCheckInterval = null;
function startDailyChecks() {
  // Логика перенесена в startBot()
}

async function startBot() {
  try {
    // Инициализация БД
    const hasDB = await initDatabase();
    console.log(hasDB ? '✅ Используется PostgreSQL' : '⚠️ Используется локальное хранение');
    
    // Загрузка данных
    await loadData();
    
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
    
    // ОЧИСТКА АКЦИЙ - РАЗ В СУТКИ В ПОЛНОЧЬ
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
        console.log(`🗑 Очищено ${oldCount - filtered.length} старых акций`);
        await saveData();
      }
    }, 24 * 60 * 60 * 1000);
    
    console.log('✅ MagicAir бот запущено с PostgreSQL!');
    console.log(`📊 Загружено: ${Object.keys(userProfiles).length} профилей, ${activePromotions.length} акций`);
    
  } catch (error) {
    console.error('❌ Критическая ошибка при запуске:', error);
    process.exit(1);
  }
}

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
































































