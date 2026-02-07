require('dotenv').config(); // Load environment variables from .env file
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const randomstring = require('randomstring');

// --- Configuration from Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const ADMIN_ID = parseInt(process.env.ADMIN_ID); // Admin ID must be a number

// --- Google Sheets API Setup ---
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS), // Service account key JSON
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});
const sheets = google.sheets({ version: 'v4', auth });

const bot = new TelegramBot(TOKEN, { polling: true });

// --- Global Data Store (for temporary user state) ---
const userStates = {}; // Stores { userId: { state: 'waiting_for_captcha', data: {} } }

// --- Utility Functions for Google Sheets ---
async function appendRow(sheetName, rowData) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: sheetName + '!A:A',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [rowData] },
  });
}

async function getRows(sheetName) {
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: sheetName + '!A:ZZ',
  });
  const rows = response.data.values;
  if (!rows || rows.length === 0) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    let obj = {};
    headers.forEach((header, i) => {
      obj[header] = row[i];
    });
    return obj;
  });
}

async function updateRow(sheetName, searchColumn, searchValue, newData) {
  const rows = await getRows(sheetName);
  const rowIndex = rows.findIndex(row => row[searchColumn] === searchValue);
  if (rowIndex === -1) return false;

  const rowData = rows[rowIndex];
  const headers = Object.keys(rowData);
  let newRow = headers.map(header => newData[header] !== undefined ? newData[header] : rowData[header]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A${rowIndex + 2}`, // +2 because header row + 0-based index
    valueInputOption: 'USER_ENTERED',
    resource: { values: [newRow] },
  });
  return true;
}

// --- Bot Commands and Logic ---

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user is blocked (from Google Sheet 'Users' tab)
  const users = await getRows('Users');
  const userRecord = users.find(u => u.UserID == userId); // Use == for comparison
  if (userRecord && userRecord.Status === 'Blocked') {
    bot.sendMessage(chatId, "🚫 **Access Denied**\nYou are blocked from this bot. Please use the 🆘 Support button to contact Admin.", { parse_mode: 'Markdown' });
    return;
  }

  // Check if user is verified (from Google Sheet 'Users' tab)
  if (userRecord && userRecord.Status === 'Active' && userRecord.Verified === 'Yes') {
    return showMainMenu(chatId);
  }

  // New user or unverified
  await bot.sendMessage(chatId, "👋 **Welcome to Shein Voucher Hub**\n\nPlease join our official channels to continue:", {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "📢 Main Channel", url: "https://t.me/SheinVoucherHub" }],
        [{ text: "📦 Order Channel", url: "https://t.me/OrdersNotify" }],
        [{ text: "✅ I've Joined - Verify", callback_data: 'check_join' }]
      ]
    }
  });
});

// Callback for 'check_join'
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  bot.answerCallbackQuery(callbackQuery.id); // Acknowledge callback query

  if (data === 'check_join') {
    // Check channel membership (requires bot to be admin in channel)
    try {
      const chatMember = await bot.getChatMember('@SheinVoucherHub', userId);
      if (chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator') {
        return sendCaptcha(chatId, userId);
      } else {
        bot.sendMessage(chatId, "❌ **Verification Failed!**\nPlease join @SheinVoucherHub first and then tap verify again.", { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error("Error checking chat member:", error);
      bot.sendMessage(chatId, "An error occurred during verification. Please try again later.", { parse_mode: 'Markdown' });
      // Notify admin
      bot.sendMessage(ADMIN_ID, `Error in check_join for user ${userId}: ${error.message}`);
    }
  }
});

// Function to send CAPTCHA
async function sendCaptcha(chatId, userId) {
  const n1 = Math.floor(Math.random() * 10) + 1;
  const n2 = Math.floor(Math.random() * 10) + 1;
  const answer = n1 + n2;

  userStates[userId] = { state: 'waiting_for_captcha', answer: answer };

  await bot.sendMessage(chatId, `🤖 **Security Check**\n\nSolve this to prove you are human:\n\`${n1} + ${n2} = ?\`\n\nType the answer below:`, { parse_mode: 'Markdown' });
}

// Handle CAPTCHA response
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = userStates[userId];

  if (userState && userState.state === 'waiting_for_captcha') {
    const userAnswer = parseInt(msg.text);
    if (!isNaN(userAnswer) && userAnswer === userState.answer) {
      delete userStates[userId]; // Clear state
      await bot.sendMessage(chatId, "✅ **Verified Successfully!**", { parse_mode: 'Markdown' });

      // Update user status in Google Sheet 'Users' tab
      const users = await getRows('Users');
      const userRecord = users.find(u => u.UserID == userId);

      if (userRecord) {
        await updateRow('Users', 'UserID', userId.toString(), { Status: 'Active', Verified: 'Yes' });
      } else {
        await appendRow('Users', [userId.toString(), msg.from.first_name, new Date().toLocaleString(), 'Active', 'Yes']);
      }
      return showMainMenu(chatId);
    } else {
      await bot.sendMessage(chatId, "❌ Wrong answer. Please try again.", { parse_mode: 'Markdown' });
      return sendCaptcha(chatId, userId); // Resend captcha
    }
  }
  // If not waiting for captcha, let other handlers process
});

// --- Main Menu Function ---
async function showMainMenu(chatId) {
  await bot.sendMessage(chatId, "🏠 **Main Menu**\n\nWelcome back! Choose an option from below:", {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [
        [{ text: "🛍️ Buy Vouchers" }, { text: "📦 My Orders" }],
        [{ text: "🔄 Recover Vouchers" }, { text: "🆘 Support" }],
        [{ text: "📜 Disclaimer" }]
      ],
      resize_keyboard: true
    }
  });
}

// --- Buy Vouchers Flow ---
bot.onText(/🛍️ Buy Vouchers/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const users = await getRows('Users');
  const userRecord = users.find(u => u.UserID == userId);
  if (userRecord && userRecord.Status === 'Blocked') {
    bot.sendMessage(chatId, "🚫 **Access Denied**\nYou are blocked from this bot.", { parse_mode: 'Markdown' });
    return;
  }

  const categories = await getRows('Categories');
  if (!categories || categories.length === 0) {
    bot.sendMessage(chatId, "❌ No vouchers available. Admin needs to add categories to the Google Sheet.", { parse_mode: 'Markdown' });
    return;
  }

  const inlineKeyboard = categories.map(cat => ([
    { text: `₹${cat.Value} Voucher (Stock: ${cat.Stock})`, callback_data: `select_qty_${cat.CategoryID}` }
  ]));

  await bot.sendMessage(chatId, "🛍️ **Select Voucher Category:**", {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard }
  });
});

// Callback for 'select_qty_CATEGORYID'
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  bot.answerCallbackQuery(callbackQuery.id);

  if (data.startsWith('select_qty_')) {
    const categoryId = data.replace('select_qty_', '');
    userStates[userId] = { state: 'waiting_for_qty_input', categoryId: categoryId };

    const categories = await getRows('Categories');
    const selectedCat = categories.find(c => c.CategoryID === categoryId);

    if (!selectedCat) {
      bot.sendMessage(chatId, "❌ Error: Selected category not found. Please try again.", { parse_mode: 'Markdown' });
      return;
    }

    const p1 = parseFloat(selectedCat.Price1 || selectedCat.Price || 0).toFixed(2);
    const text = `📦 **₹${selectedCat.Value} Shein Voucher**\nAvailable stock: ${selectedCat.Stock} codes\n\nRate: ₹${p1} / code\n\n**Select quantity:**`;

    const inlineKeyboard = [
      [{ text: "1 code", callback_data: `qty_1_${categoryId}` }, { text: "5 codes", callback_data: `qty_5_${categoryId}` }],
      [{ text: "10 codes", callback_data: `qty_10_${categoryId}` }, { text: "Custom", callback_data: `qty_custom_${categoryId}` }],
      [{ text: "⬅️ Back", callback_data: "back_to_buy_vouchers" }]
    ];

    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  } else if (data.startsWith('qty_')) { // Handles 1, 5, 10, custom quantity buttons
    const parts = data.split('_'); // e.g., ['qty', '1', 'cat_500']
    const qty = parseInt(parts[1]);
    const categoryId = parts[2];

    if (parts[1] === 'custom') {
      userStates[userId] = { state: 'waiting_for_custom_qty_input', categoryId: categoryId };
      await bot.sendMessage(chatId, "🔢 Please type the **number of codes** you want to buy:", { parse_mode: 'Markdown' });
    } else if (!isNaN(qty)) {
      return processQuantityAndShowPayment(chatId, userId, categoryId, qty);
    }
  } else if (data === 'back_to_buy_vouchers') {
    return bot.onText(/🛍️ Buy Vouchers/, async (msg) => { const dummyMsg = { chat: { id: chatId }, from: { id: userId, first_name: callbackQuery.from.first_name, username: callbackQuery.from.username } }; bot.emit('message', dummyMsg); }); // Simulate buy vouchers command
  }
});

// Handle Custom Quantity Input
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = userStates[userId];

  if (userState && userState.state === 'waiting_for_custom_qty_input') {
    const qty = parseInt(msg.text);
    if (!isNaN(qty) && qty > 0) {
      delete userStates[userId]; // Clear state
      return processQuantityAndShowPayment(chatId, userId, userState.categoryId, qty);
    } else {
      await bot.sendMessage(chatId, "❌ Invalid number. Please enter a valid quantity.", { parse_mode: 'Markdown' });
      userStates[userId].state = 'waiting_for_custom_qty_input'; // Keep state for retry
    }
  }
});

// Function to process quantity and show payment
async function processQuantityAndShowPayment(chatId, userId, categoryId, qty) {
  const categories = await getRows('Categories');
  const cat = categories.find(c => c.CategoryID === categoryId);

  if (!cat) {
    bot.sendMessage(chatId, "❌ Error: Category data missing. Please try again.", { parse_mode: 'Markdown' });
    return;
  }

  if (qty > cat.Stock) {
    bot.sendMessage(chatId, `❌ Not enough stock! Only ${cat.Stock} codes available for ₹${cat.Value} Voucher.`, { parse_mode: 'Markdown' });
    userStates[userId] = { state: 'waiting_for_qty_input', categoryId: categoryId }; // Go back to quantity prompt
    return;
  }

  // Tiered Price Calculation (simplified)
  let rate;
  if (qty >= 20) rate = parseFloat(cat.Price20Plus || cat.Price10 || cat.Price5 || cat.Price1 || cat.Price);
  else if (qty >= 10) rate = parseFloat(cat.Price10 || cat.Price5 || cat.Price1 || cat.Price);
  else if (qty >= 5) rate = parseFloat(cat.Price5 || cat.Price1 || cat.Price);
  else rate = parseFloat(cat.Price1 || cat.Price);

  if (isNaN(rate) || rate <= 0) {
    bot.sendMessage(chatId, "❌ Error: Pricing not set for this quantity. Please contact Admin.", { parse_mode: 'Markdown' });
    return;
  }

  const totalCost = rate * qty;

  userStates[userId] = {
    state: 'waiting_for_proof',
    categoryId: categoryId,
    qty: qty,
    totalCost: totalCost
  };

  const cap = `💳 **Payment Required**\n\nItem: ₹${cat.Value} Voucher\nQuantity: ${qty}\nRate: ₹${rate.toFixed(2)} / code\n----------------------------------\n💰 **Total Amount: ₹${totalCost.toFixed(2)}**\n\nScan the QR code and click 'Paid' after payment:`;
  
  await bot.sendPhoto(chatId, "https://i.supaimg.com/00332ad4-8aa7-408f-8705-55dbc91ea737.jpg", {
    caption: cap,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[{ text: "✅ Paid - Submit Proof", callback_data: 'submit_proof' }]]
    }
  });
}

// Callback for 'submit_proof'
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  bot.answerCallbackQuery(callbackQuery.id);

  if (data === 'submit_proof') {
    userStates[userId].state = 'waiting_for_screenshot';
    await bot.sendMessage(chatId, "📸 Please send the **screenshot** of your payment proof:", { parse_mode: 'Markdown' });
  }
});

// Handle Payment Screenshot
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = userStates[userId];

  if (userState && userState.state === 'waiting_for_screenshot') {
    if (msg.photo && msg.photo.length > 0) {
      userStates[userId].proofId = msg.photo[msg.photo.length - 1].file_id; // Get highest resolution photo
      userStates[userId].state = 'waiting_for_utr';
      await bot.sendMessage(chatId, "✅ Screenshot received! Now, please send your **12-digit UPI Transaction ID / UTR Number**:", { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, "❌ That was not a photo. Please send a screenshot of your payment.", { parse_mode: 'Markdown' });
      userStates[userId].state = 'waiting_for_screenshot'; // Keep state for retry
    }
  } else if (userState && userState.state === 'waiting_for_utr') {
    const utr = msg.text.trim();
    if (utr.length === 12 && !isNaN(parseInt(utr))) {
      delete userStates[userId].state; // Clear state
      return submitOrder(chatId, userId, utr);
    } else {
      await bot.sendMessage(chatId, "❌ Invalid UTR. Please enter a 12-digit number.", { parse_mode: 'Markdown' });
      userStates[userId].state = 'waiting_for_utr'; // Keep state for retry
    }
  }
});

// Function to submit order to Google Sheet
async function submitOrder(chatId, userId, utr) {
  const orderId = `SVH-${randomstring.generate(7).toUpperCase()}-${randomstring.generate(6).toUpperCase()}`;
  const userState = userStates[userId];

  const orderData = [
    orderId,
    userId.toString(),
    msg.from.first_name, // Get user's first name
    userState.categoryId,
    userState.qty.toString(),
    userState.totalCost.toFixed(2),
    utr,
    'Pending',
    '', // Vouchers will be added on approval
    new Date().toLocaleString()
  ];

  await appendRow('Orders', orderData);

  await bot.sendMessage(chatId, `✅ **Order Submitted!**\nOrder ID: \`${orderId}\`\nStatus: **Pending Admin Approval**.\n\nAdmin will verify your payment soon.`, { parse_mode: 'Markdown' });

  // Notify Admin with screenshot
  await bot.sendPhoto(ADMIN_ID, userState.proofId, {
    caption: `🎯 **New Order Submitted**\nID: \`${orderId}\`\nUser: ${msg.from.first_name} (\`${userId}\`)\nCategory: ${userState.categoryId}\nQuantity: ${userState.qty}\nTotal: ₹${userState.totalCost.toFixed(2)}\nUTR: \`${utr}\``,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Approve", callback_data: `adm_approve_${orderId}` }],
        [{ text: "❌ Decline", callback_data: `adm_decline_${orderId}` }]
      ]
    }
  });
  delete userStates[userId]; // Clear all user states after submission
}


// --- My Orders Flow ---
bot.onText(/📦 My Orders/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const orders = await getRows('Orders');
  const userOrders = orders.filter(o => o.UserID == userId.toString()); // Filter by user ID

  if (userOrders.length === 0) {
    bot.sendMessage(chatId, "📦 You don't have any orders yet.", { parse_mode: 'Markdown' });
    return;
  }

  let history_msg = "📦 **Your Order History**\n\n";
  userOrders.forEach(order => {
    const status_emoji = order.Status === "Successful" ? "✅" : (order.Status === "Declined" ? "❌" : "⏳");
    history_msg += `🧾 \`${order.OrderID}\`\n` +
                   `🎟 ₹${order.Category} | Qty ${order.Qty}\n` +
                   `💰 ₹${parseFloat(order.Total).toFixed(2)} | ${status_emoji} ${order.Status}\n`;
    if (order.Status === "Successful" && order.VoucherCodeDelivered) {
      history_msg += `🎁 Codes: \`${order.VoucherCodeDelivered}\`\n`;
    }
    history_msg += "----------------------------------\n";
  });
  bot.sendMessage(chatId, history_msg, { parse_mode: 'Markdown' });
});

// --- Recover Vouchers Flow ---
bot.onText(/🔄 Recover Vouchers/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  userStates[userId] = { state: 'waiting_for_recovery_oid' };
  await bot.sendMessage(chatId, "🔁 **Recover Vouchers**\n\nEnter your Order ID (Example: `SVH-XXXX-XXXX-XXXXXX`):", { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const userState = userStates[userId];

    if (userState && userState.state === 'waiting_for_recovery_oid') {
        const orderId = msg.text.trim();
        const orders = await getRows('Orders');
        const order = orders.find(o => o.OrderID === orderId);

        if (!order || order.UserID !== userId.toString()) { // Ensure only owner can recover
            bot.sendMessage(chatId, `⚠️ **Order not found!**\nThe ID \`${orderId}\` does not exist in your orders.`, { parse_mode: 'Markdown' });
        } else if (order.Status === 'Successful') {
            bot.sendMessage(chatId, `✅ **Vouchers Found!**\nOrder ID: \`${orderId}\`\nCodes: \`${order.VoucherCodeDelivered}\``, { parse_mode: 'Markdown' });
        } else {
            bot.sendMessage(chatId, `⏳ Status: **${order.Status}**\nAdmin is currently verifying your payment.`, { parse_mode: 'Markdown' });
        }
        delete userStates[userId]; // Clear state
    }
    // ... other message handlers
});

// --- Disclaimer ---
bot.onText(/📜 Disclaimer/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.sendMessage(chatId, "📜 **Disclaimer**\n\nAll coupons given are 100% OFF up to voucher amount with NO minimum order amount required.\n\nOnly replacements are allowed if a support ticket is raised within 1–2 hours of delivery. No returns.", { parse_mode: 'Markdown' });
});

// --- Support Flow ---
bot.onText(/🆘 Support/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  userStates[userId] = { state: 'in_support_mode' };
  await bot.sendMessage(chatId, "💬 **Support Mode Enabled**\n\nSend your message, photo, or video. Admin will receive it directly.\n\nTo exit, type or tap `/cancel`.", {
    parse_mode: 'Markdown',
    reply_markup: {
      keyboard: [[{ text: "/cancel" }]],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  });
});

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  if (userStates[userId] && userStates[userId].state === 'in_support_mode') {
    delete userStates[userId]; // Clear state
    await bot.sendMessage(chatId, "✅ Exited support mode.", {
      reply_markup: { remove_keyboard: true }
    });
    return showMainMenu(chatId);
  }
  // If not in support mode, do nothing or send unknown command message
});

// Admin Reply Text Handler (for support messages)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = userStates[userId];

  // Only process if user is in support mode
  if (userState && userState.state === 'in_support_mode') {
    if (msg.text === '/cancel') return; // Handled by /cancel command

    let messageContent = msg.text;
    if (msg.photo && msg.photo.length > 0) {
      messageContent = `Photo ID: ${msg.photo[msg.photo.length - 1].file_id}\nCaption: ${msg.caption || 'No caption'}`;
      await bot.sendPhoto(ADMIN_ID, msg.photo[msg.photo.length - 1].file_id, {
        caption: `🆘 **Support Msg (Photo)** from ${msg.from.first_name} (\`${userId}\`):\n\n${msg.caption || ''}`,
        parse_mode: 'Markdown'
      });
    } else {
      await bot.sendMessage(ADMIN_ID, `🆘 **Support Msg** from ${msg.from.first_name} (\`${userId}\`):\n\n${messageContent}`, { parse_mode: 'Markdown' });
    }
    await bot.sendMessage(chatId, "✅ Your message has been forwarded to Admin.", { parse_mode: 'Markdown' });
    return;
  }
  // If not in support mode, let other message handlers run (e.g., CAPTCHA)
});

// --- Admin Panel ---
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) {
    bot.sendMessage(chatId, "🚫 **Access Denied!** You are not an admin.", { parse_mode: 'Markdown' });
    return;
  }

  const inlineKeyboard = [
    [{ text: "➕ Add Category", callback_data: "adm_add_cat_prompt" }, { text: "🗑️ Delete Category", callback_data: "adm_del_cat_list" }],
    [{ text: "📦 Add Stock", callback_data: "adm_add_stock_prompt" }, { text: "💰 Set Prices", callback_data: "adm_pricing_menu" }],
    [{ text: "📢 Broadcast", callback_data: "adm_bc_prompt" }, { text: "💬 DM User", callback_data: "adm_dm_prompt" }],
    [{ text: "🚫 Block/Unblock User", callback_data: "adm_block_prompt" }],
    [{ text: "📈 View Stats", callback_data: "adm_view_stats" }],
    [{ text: "⬅️ Back to Main Menu", callback_data: "adm_back_to_main" }]
  ];

  await bot.sendMessage(chatId, "👑 **Admin Hub**\n\nManage your bot operations:", {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard }
  });
});

// Admin Callback Handlers
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  bot.answerCallbackQuery(callbackQuery.id);

  if (userId !== ADMIN_ID) {
    bot.sendMessage(chatId, "🚫 **Access Denied!** You are not an admin.", { parse_mode: 'Markdown' });
    return;
  }

  if (data.startsWith('adm_approve_')) {
    const orderId = data.replace('adm_approve_', '');
    // Fetch order from Google Sheet
    const orders = await getRows('Orders');
    const orderToApprove = orders.find(o => o.OrderID === orderId);

    if (!orderToApprove || orderToApprove.Status !== 'Pending') {
      bot.sendMessage(chatId, `❌ Order ${orderId} not found or already processed.`, { parse_mode: 'Markdown' });
      return;
    }

    // Fetch category to get stock and codes
    const categories = await getRows('Categories');
    const categoryToUpdate = categories.find(c => c.CategoryID === orderToApprove.Category);

    if (!categoryToUpdate || categoryToUpdate.Stock < orderToApprove.Quantity) {
      bot.sendMessage(chatId, `❌ Cannot approve. Stock for ${orderToApprove.Category} is low. Available: ${categoryToUpdate ? categoryToUpdate.Stock : 0}`, { parse_mode: 'Markdown' });
      return;
    }
    
    let voucherCodes = categoryToUpdate.VoucherCodes ? categoryToUpdate.VoucherCodes.split('\n').filter(c => c.trim().length > 0) : [];
    if (voucherCodes.length < orderToApprove.Quantity) {
        bot.sendMessage(chatId, `❌ Cannot approve. Insufficient specific codes for ${orderToApprove.Category}. Available codes: ${voucherCodes.length}`, { parse_mode: 'Markdown' });
        return;
    }

    // Release codes
    const releasedCodes = voucherCodes.splice(0, parseInt(orderToApprove.Quantity));
    const newVoucherCodes = releasedCodes.join('\n'); // Store delivered codes for recovery
    const updatedCategoryStock = categoryToUpdate.Stock - parseInt(orderToApprove.Quantity);
    
    // Update Google Sheet 'Categories' tab
    await updateRow('Categories', 'CategoryID', categoryToUpdate.CategoryID, {
        Stock: updatedCategoryStock.toString(),
        VoucherCodes: voucherCodes.join('\n') // Remaining codes
    });

    // Update Google Sheet 'Orders' tab
    await updateRow('Orders', 'OrderID', orderId, {
      Status: 'Successful',
      VoucherCodeDelivered: newVoucherCodes
    });

    // Notify User
    await bot.sendMessage(orderToApprove.UserID, `✅ **Order Approved!**\nOrder ID: \`${orderId}\` is complete.\n\n🎟 **Your Voucher Codes:**\n\`${newVoucherCodes}\`\n\n*(Tap code to copy)*\n\nThank you for choosing Shein Voucher Hub!`, { parse_mode: 'Markdown' });

    // Notify Admin and Orders Channel
    await bot.sendMessage(chatId, `✅ Order \`${orderId}\` approved. Voucher sent to user.`, { parse_mode: 'Markdown' });
    await bot.sendMessage(process.env.ORDERS_NOTIFY_CHANNEL_ID || '@OrdersNotify', `🎯 𝗡𝗲𝘄 𝗢𝗿𝗱𝗲𝗿 𝗦𝘂𝗯𝗺𝗶𝘁𝘁𝗲𝗱\n━━━━━━━━━━━•❈•━━━━━━━━━━━\n╰➤👤 𝗨𝗦𝗘𝗥 𝗡𝗔𝗠𝗘 : ${orderToApprove.UserName}\n╰➤🆔 𝗨𝗦𝗘𝗥 𝗜𝗗 : \`${orderToApprove.UserID}\`\n╰➤📡 𝗦𝗧𝗔𝗧𝗨𝗦: ✅ Success\n╰➤ 🔰𝗤𝗨𝗔𝗟𝗜𝗧𝗬: High 📶\n╰➤ 📦𝗧𝗢𝗧𝗔𝗟 𝗤𝗨𝗔𝗡𝗧𝗜𝗧𝗬 : ${orderToApprove.Quantity}\n╰➤ 💳𝗖𝗢𝗦𝗧 : ₹${parseFloat(orderToApprove.Total).toFixed(2)}\n\n🤖𝗕𝗢𝗧 𝗡𝗔𝗠𝗘 : @SheinVoucherHub_Bot\n━━━━━━━━━━━•❈•━━━━━━━━━━━`, { parse_mode: 'Markdown' });

  } else if (data.startsWith('adm_decline_')) {
    const orderId = data.replace('adm_decline_', '');
    // Update Google Sheet 'Orders' tab
    await updateRow('Orders', 'OrderID', orderId, { Status: 'Declined' });
    bot.sendMessage(chatId, `❌ Order ${orderId} declined.`, { parse_mode: 'Markdown' });
    // Notify user of decline
    const orders = await getRows('Orders');
    const orderToDecline = orders.find(o => o.OrderID === orderId);
    if (orderToDecline) {
        await bot.sendMessage(orderToDecline.UserID, `❌ **Your Order Has Been Declined**\nOrder ID: \`${orderId}\`\n\nThere was an issue with your payment proof or transaction ID. Please contact support for assistance.`, { parse_mode: 'Markdown' });
    }

  } else if (data === 'adm_add_cat_prompt') {
    userStates[userId] = { state: 'adm_waiting_for_cat_value' };
    await bot.sendMessage(chatId, "➕ **Add New Category**\n\nEnter the **Face Value** (e.g., 500, 1000). Only type the number.", { parse_mode: 'Markdown' });
  } else if (userStates[userId] && userStates[userId].state === 'adm_waiting_for_cat_price') {
    // This state logic needs to be handled in the main message listener
  } else if (data === 'adm_del_cat_list') {
    const categories = await getRows('Categories');
    if (!categories || categories.length === 0) {
        bot.sendMessage(chatId, "❌ No categories to delete.", { parse_mode: 'Markdown' });
        return;
    }
    const inlineKeyboard = categories.map(cat => ([
        { text: `🗑️ Delete ₹${cat.Value} Voucher`, callback_data: `adm_del_cat_confirm_${cat.CategoryID}` }
    ]));
    await bot.sendMessage(chatId, "⚠️ **Delete Category**\n\nSelect a category to PERMANENTLY delete:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  } else if (data.startsWith('adm_del_cat_confirm_')) {
    const categoryIdToDelete = data.replace('adm_del_cat_confirm_', '');
    await sheets.spreadsheets.values.clear({
        spreadsheetId: SHEET_ID,
        range: `Categories!A:Z`, // Clear entire sheet
    });
    const categories = await getRows('Categories'); // Get all rows again
    const updatedCategories = categories.filter(cat => cat.CategoryID !== categoryIdToDelete);
    await sheets.spreadsheets.values.append({ // Append filtered rows
        spreadsheetId: SHEET_ID,
        range: 'Categories!A:A',
        valueInputOption: 'USER_ENTERED',
        resource: { values: [Object.keys(categories[0]), ...updatedCategories.map(Object.values)] }, // Re-add headers and data
    });
    bot.sendMessage(chatId, `✅ Category ${categoryIdToDelete} deleted.`, { parse_mode: 'Markdown' });
  }
  // --- More Admin Callback handlers here for other buttons ---
  else if (data === 'adm_back_to_main') {
    return showMainMenu(chatId);
  }
});

// Admin message handler for category value and price input
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = userStates[userId];

  if (userId !== ADMIN_ID) { // Only process admin messages here for admin states
    return;
  }

  if (userState && userState.state === 'adm_waiting_for_cat_value') {
    const value = parseInt(msg.text);
    if (isNaN(value) || value <= 0) {
      bot.sendMessage(chatId, "❌ Invalid input. Please enter a valid number for the face value.", { parse_mode: 'Markdown' });
      return;
    }
    userStates[userId].temp_cat_value = value;
    userStates[userId].state = 'adm_waiting_for_cat_price';
    await bot.sendMessage(chatId, `✅ Face Value set to ₹${value}.\n\nEnter the **Default Selling Price per code** for this category (e.g., 39).`, { parse_mode: 'Markdown' });
  } else if (userState && userState.state === 'adm_waiting_for_cat_price') {
    const price = parseFloat(msg.text);
    if (isNaN(price) || price <= 0) {
      bot.sendMessage(chatId, "❌ Invalid input. Please enter a valid number for the selling price.", { parse_mode: 'Markdown' });
      return;
    }

    const value = userStates[userId].temp_cat_value;
    const categoryId = `cat_${value}`;

    // Add new category to Google Sheet 'Categories' tab
    await appendRow('Categories', [categoryId, value.toString(), price.toFixed(2), '0', '', price.toFixed(2), price.toFixed(2), price.toFixed(2), price.toFixed(2)]); // Tiered prices default to main price

    delete userStates[userId]; // Clear state
    await bot.sendMessage(chatId, `✅ **New Category ₹${value} Created!**\nDefault Price: ₹${price.toFixed(2)}.\n\nDon't forget to add stock and set tiered pricing!`, { parse_mode: 'Markdown' });
    await bot.onText(/\/admin/, async (adminMsg) => { const dummyAdminMsg = { chat: { id: chatId }, from: { id: userId, first_name: msg.from.first_name, username: msg.from.username } }; bot.emit('message', dummyAdminMsg); }); // Simulate /admin command
  }
});

// --- Catch-all Message Handler (for support, admin DM) ---
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Admin Manual Reply: /msg [UserID] [Text]
    if (userId === ADMIN_ID && msg.text && msg.text.startsWith('/msg')) {
        const parts = msg.text.split(' ');
        if (parts.length < 3) {
            bot.sendMessage(chatId, 'Usage: /msg <UserID> <Message>', { parse_mode: 'Markdown' });
            return;
        }
        const targetId = parseInt(parts[1]);
        const messageText = parts.slice(2).join(' ');

        try {
            await bot.sendMessage(targetId, `📩 **Message from Admin:**\n\n${messageText}`, { parse_mode: 'Markdown' });
            bot.sendMessage(chatId, `✅ Message sent to User ID: \`${targetId}\`.`, { parse_mode: 'Markdown' });
        } catch (error) {
            bot.sendMessage(chatId, `❌ Failed to send message to User ID: \`${targetId}\`. Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
        return;
    }
    
    // Support message handling for users (only if in support mode)
    const userState = userStates[userId];
    if (userState && userState.state === 'in_support_mode') {
        if (msg.text === '/cancel') return; // Handled by /cancel command

        let messageContent = msg.text;
        if (msg.photo && msg.photo.length > 0) {
            await bot.sendPhoto(ADMIN_ID, msg.photo[msg.photo.length - 1].file_id, {
                caption: `🆘 **Support Msg (Photo)** from ${msg.from.first_name} (\`${userId}\`):\n\n${msg.caption || ''}`,
                parse_mode: 'Markdown'
            });
        } else {
            await bot.sendMessage(ADMIN_ID, `🆘 **Support Msg** from ${msg.from.first_name} (\`${userId}\`):\n\n${messageContent}`, { parse_mode: 'Markdown' });
        }
        await bot.sendMessage(chatId, "✅ Your message has been forwarded to Admin.", { parse_mode: 'Markdown' });
        return;
    }

    // Default message for unrecognized commands/text outside specific states
    if (!msg.text.startsWith('/') && !(userState && (userState.state === 'waiting_for_captcha' || userState.state === 'waiting_for_custom_qty_input' || userState.state === 'waiting_for_screenshot' || userState.state === 'waiting_for_utr' || userState.state === 'waiting_for_recovery_oid'))) {
        await bot.sendMessage(chatId, "I don't understand that. Please use the menu buttons or commands.", { parse_mode: 'Markdown' });
        await showMainMenu(chatId); // Display main menu
    }
});
