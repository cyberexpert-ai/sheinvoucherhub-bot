require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const randomstring = require('randomstring');

// --- Configuration from Environment Variables ---
const TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const ORDERS_NOTIFY_CHANNEL_ID = process.env.ORDERS_NOTIFY_CHANNEL_ID || '@OrdersNotify'; // Can be ID or username

// --- Google Sheets API Setup ---
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive'],
});
const sheets = google.sheets({ version: 'v4', auth });

const bot = new TelegramBot(TOKEN, { polling: true });

// --- Global Data Store (for temporary user state during conversations) ---
const userStates = {}; // { userId: { state: 'waiting_for_captcha', data: {} } }

// --- Utility Functions for Google Sheets (Centralized) ---
async function getSheetRows(sheetName) {
  try {
    const response = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: sheetName + '!A:ZZ' });
    const rows = response.data.values;
    if (!rows || rows.length === 0) return [];
    const headers = rows[0];
    return rows.slice(1).map(row => {
      let obj = {};
      headers.forEach((header, i) => { obj[header] = row[i]; });
      return obj;
    });
  } catch (error) {
    console.error(`Error getting rows from ${sheetName}:`, error.message);
    bot.sendMessage(ADMIN_ID, `⚠️ Sheet Error (getRows): ${sheetName} - ${error.message}`);
    return [];
  }
}

async function appendSheetRow(sheetName, rowData) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: sheetName + '!A:A',
      valueInputOption: 'USER_ENTERED',
      resource: { values: [rowData] },
    });
    return true;
  } catch (error) {
    console.error(`Error appending row to ${sheetName}:`, error.message);
    bot.sendMessage(ADMIN_ID, `⚠️ Sheet Error (appendRow): ${sheetName} - ${error.message}`);
    return false;
  }
}

async function updateSheetRow(sheetName, searchColumn, searchValue, newData) {
  try {
    const rows = await getSheetRows(sheetName);
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
  } catch (error) {
    console.error(`Error updating row in ${sheetName}:`, error.message);
    bot.sendMessage(ADMIN_ID, `⚠️ Sheet Error (updateRow): ${sheetName} - ${error.message}`);
    return false;
  }
}

async function deleteSheetRow(sheetName, searchColumn, searchValue) {
    try {
        const rows = await getSheetRows(sheetName);
        const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
        const initialRowCount = rows.length;

        const updatedRows = rows.filter(row => row[searchColumn] !== searchValue);
        
        // Clear the entire sheet
        await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: sheetName + '!A:Z' });

        // If there are rows remaining, re-append headers and data
        if (updatedRows.length > 0) {
            const valuesToAppend = [headers, ...updatedRows.map(Object.values)];
            await sheets.spreadsheets.values.append({
                spreadsheetId: SHEET_ID,
                range: sheetName + '!A:A',
                valueInputOption: 'USER_ENTERED',
                resource: { values: valuesToAppend },
            });
        } else if (initialRowCount > 0) {
             // If all rows were deleted, just re-append headers
             await appendSheetRow(sheetName, headers);
        }
        return true;
    } catch (error) {
        console.error(`Error deleting row from ${sheetName}:`, error.message);
        bot.sendMessage(ADMIN_ID, `⚠️ Sheet Error (deleteRow): ${sheetName} - ${error.message}`);
        return false;
    }
}

// --- Logging Function (for fraud detection etc.) ---
async function logActivity(userId, action, details) {
  await appendSheetRow('Logs', [new Date().toLocaleString(), userId.toString(), action, details]);
}


// --- Reply Keyboard Definitions ---
const mainMenuKeyboard = {
  keyboard: [
    [{ text: "🛍️ Buy Vouchers" }, { text: "📦 My Orders" }],
    [{ text: "🔄 Recover Vouchers" }, { text: "🆘 Support" }],
    [{ text: "📜 Disclaimer" }]
  ],
  resize_keyboard: true
};

const cancelKeyboard = {
  keyboard: [[{ text: "/cancel" }]],
  resize_keyboard: true,
  one_time_keyboard: false
};


// --- Helper Function: Show Main Menu ---
async function showMainMenu(chatId) {
  await bot.sendMessage(chatId, "🏠 **Main Menu**\n\nWelcome back! Choose an option from below:", {
    parse_mode: 'Markdown',
    reply_markup: mainMenuKeyboard
  });
}

// --- Helper Function: Send CAPTCHA ---
async function sendCaptcha(chatId, userId) {
  const n1 = Math.floor(Math.random() * 10) + 1;
  const n2 = Math.floor(Math.random() * 10) + 1;
  const answer = n1 + n2;

  userStates[userId] = { state: 'waiting_for_captcha', answer: answer };

  await bot.sendMessage(chatId, `🤖 **Security Check**\n\nSolve this to prove you are human:\n\`${n1} + ${n2} = ?\`\n\nType the answer below:`, { parse_mode: 'Markdown' });
}


// --- Bot Event Handlers ---

// /start command
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  
  // Check if user is blocked
  const users = await getSheetRows('Users');
  const userRecord = users.find(u => u.UserID == userId.toString());
  if (userRecord && userRecord.Status === 'Blocked') {
    return bot.sendMessage(chatId, "🚫 **Access Denied**\nYou are blocked from this bot. Please use the 🆘 Support button to contact Admin.", { parse_mode: 'Markdown' });
  }

  // Check if user is verified
  if (userRecord && userRecord.Verified === 'Yes') {
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

// --- Callback Query Handler (for inline buttons) ---
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  bot.answerCallbackQuery(callbackQuery.id); // Acknowledge the button press

  // --- User Verification Flow ---
  if (data === 'check_join') {
    try {
      const chatMember = await bot.getChatMember('@SheinVoucherHub', userId); // Needs bot to be admin in channel
      if (chatMember.status === 'member' || chatMember.status === 'administrator' || chatMember.status === 'creator') {
        return sendCaptcha(chatId, userId);
      } else {
        bot.sendMessage(chatId, "❌ **Verification Failed!**\nPlease join @SheinVoucherHub first and then tap verify again.", { parse_mode: 'Markdown' });
      }
    } catch (error) {
      console.error("Error checking chat member:", error);
      bot.sendMessage(chatId, "An error occurred during verification. Please try again later.", { parse_mode: 'Markdown' });
      bot.sendMessage(ADMIN_ID, `⚠️ Error in check_join for user ${userId}: ${error.message}`);
    }
  } 
  
  // --- Buy Vouchers Flow - Category Selection ---
  else if (data.startsWith('select_cat_')) {
    const categoryId = data.replace('select_cat_', '');
    userStates[userId] = { state: 'waiting_for_qty_selection', categoryId: categoryId };

    const categories = await getSheetRows('Categories');
    const selectedCat = categories.find(c => c.CategoryID === categoryId);

    if (!selectedCat) {
      bot.sendMessage(chatId, "❌ Error: Selected category not found. Please try again.", { parse_mode: 'Markdown' });
      return;
    }

    const p1 = parseFloat(selectedCat.Price1 || selectedCat.Price || 0).toFixed(2);
    const text = `📦 **₹${selectedCat.Value} Shein Voucher**\nAvailable stock: ${selectedCat.Stock} codes\n\nRate: ₹${p1} / code\n\n**Select quantity:**`;

    const inlineKeyboard = [
      [{ text: "1 code", callback_data: `qty_btn_1_${categoryId}` }, { text: "5 codes", callback_data: `qty_btn_5_${categoryId}` }],
      [{ text: "10 codes", callback_data: `qty_btn_10_${categoryId}` }, { text: "Custom", callback_data: `qty_btn_custom_${categoryId}` }],
      [{ text: "⬅️ Back", callback_data: "back_to_buy_vouchers" }]
    ];
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  } 
  
  // --- Buy Vouchers Flow - Quantity Buttons ---
  else if (data.startsWith('qty_btn_')) {
    const parts = data.split('_'); // e.g., ['qty', 'btn', '1', 'cat_500']
    const qty = parseInt(parts[2]); // The quantity number
    const categoryId = parts[3];

    if (parts[2] === 'custom') { // Custom button was pressed
      userStates[userId] = { state: 'waiting_for_custom_qty_input', categoryId: categoryId };
      await bot.sendMessage(chatId, "🔢 Please type the **number of codes** you want to buy:", { parse_mode: 'Markdown' });
    } else if (!isNaN(qty)) { // 1, 5, 10 quantity buttons
      return processQuantityAndShowPayment(chatId, userId, categoryId, qty);
    }
  } 
  
  // --- Payment Proof Submission ---
  else if (data === 'submit_proof') {
    userStates[userId].state = 'waiting_for_screenshot';
    await bot.sendMessage(chatId, "📸 Please send the **screenshot** of your payment proof:", { parse_mode: 'Markdown' });
  } 
  
  // --- Admin Order Management ---
  else if (data.startsWith('adm_approve_')) {
    const orderId = data.replace('adm_approve_', '');
    return handleAdminOrderAction(chatId, userId, orderId, 'Approve');
  } else if (data.startsWith('adm_decline_')) {
    const orderId = data.replace('adm_decline_', '');
    return handleAdminOrderAction(chatId, userId, orderId, 'Decline');
  }
  
  // --- Admin Category/Price Management ---
  else if (data === 'adm_add_cat_prompt') {
    userStates[userId] = { state: 'adm_waiting_for_cat_value' };
    await bot.sendMessage(chatId, "➕ **Add New Category**\n\nEnter the **Face Value** (e.g., 500, 1000). Only type the number.", { parse_mode: 'Markdown' });
  } else if (data === 'adm_del_cat_list') {
    const categories = await getSheetRows('Categories');
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
    await deleteCategory(chatId, categoryIdToDelete);
  } else if (data.startsWith('adm_add_stock_prompt')) {
    userStates[userId] = { state: 'adm_waiting_for_stock_cat_select' };
    const categories = await getSheetRows('Categories');
    if (!categories || categories.length === 0) {
        bot.sendMessage(chatId, "❌ No categories to add stock to.", { parse_mode: 'Markdown' });
        return;
    }
    const inlineKeyboard = categories.map(cat => ([
        { text: `📦 Add Stock to ₹${cat.Value} (Current: ${cat.Stock})`, callback_data: `adm_add_stock_select_cat_${cat.CategoryID}` }
    ]));
    await bot.sendMessage(chatId, "➕ **Add Voucher Codes to Stock**\n\nSelect the category:", { parse_mode: 'Markdown', reply_markup: { inline_keyboard } });
  } else if (data.startsWith('adm_add_stock_select_cat_')) {
      const categoryId = data.replace('adm_add_stock_select_cat_', '');
      userStates[userId] = { state: 'adm_waiting_for_voucher_codes', categoryId: categoryId };
      await bot.sendMessage(chatId, `⌨️ Send the voucher codes for ₹${categories.find(c => c.CategoryID === categoryId).Value}. Send one code per line, or separate with commas.`, { parse_mode: 'Markdown' });
  } else if (data.startsWith('adm_view_stock_codes_')) {
      const categoryId = data.replace('adm_view_stock_codes_', '');
      const categories = await getSheetRows('Categories');
      const cat = categories.find(c => c.CategoryID === categoryId);
      if (cat && cat.VoucherCodes) {
          bot.sendMessage(chatId, `**Voucher Codes for ₹${cat.Value}:**\n\n\`\`\`\n${cat.VoucherCodes}\n\`\`\``, { parse_mode: 'Markdown' });
      } else {
          bot.sendMessage(chatId, `No codes found for ₹${cat.Value}.`, { parse_mode: 'Markdown' });
      }
  } else if (data.startsWith('adm_remove_stock_prompt')) {
      userStates[userId] = { state: 'adm_waiting_for_code_to_remove' };
      await bot.sendMessage(chatId, "🗑️ **Remove Voucher Code**\n\nEnter the exact voucher code you want to remove from stock:", { parse_mode: 'Markdown' });
  } else if (data === 'adm_pricing_menu') {
    const categories = await getSheetRows('Categories');
    if (!categories || categories.length === 0) {
        bot.sendMessage(chatId, "❌ No categories to set prices for.", { parse_mode: 'Markdown' });
        return;
    }
    const inlineKeyboard = categories.map(cat => ([
        { text: `💰 Set Prices for ₹${cat.Value} Voucher`, callback_data: `adm_select_tier_pricing_${cat.CategoryID}` }
    ]));
    await bot.sendMessage(chatId, "📈 **Set Tiered Pricing**\n\nSelect a category to set its prices per quantity:", { parse_mode: 'Markdown', reply_markup: { inlineKeyboard } });
  } else if (data.startsWith('adm_select_tier_pricing_')) {
      const categoryId = data.replace('adm_select_tier_pricing_', '');
      userStates[userId] = { state: 'adm_waiting_for_tier_selection', categoryId: categoryId };
      const inlineKeyboard = [
          [{ text: "1 Code Price", callback_data: `adm_input_tier_price_1_${categoryId}` }, { text: "2 Codes Price", callback_data: `adm_input_tier_price_2_${categoryId}` }],
          [{ text: "3 Codes Price", callback_data: `adm_input_tier_price_3_${categoryId}` }, { text: "4 Codes Price", callback_data: `adm_input_tier_price_4_${categoryId}` }],
          [{ text: "5 Codes Price", callback_data: `adm_input_tier_price_5_${categoryId}` }, { text: "10 Codes Price", callback_data: `adm_input_tier_price_10_${categoryId}` }],
          [{ text: "20+ Codes Price", callback_data: `adm_input_tier_price_20Plus_${categoryId}` }],
          [{ text: "⬅️ Back", callback_data: "adm_pricing_menu" }]
      ];
      await bot.sendMessage(chatId, `Set price for ₹${categories.find(c => c.CategoryID === categoryId).Value} voucher. Select the quantity tier:`, { parse_mode: 'Markdown', reply_markup: { inlineKeyboard } });
  } else if (data.startsWith('adm_input_tier_price_')) {
      const parts = data.split('_'); // e.g., ['adm', 'input', 'tier', 'price', '1', 'cat_500']
      const tier = parts[4]; // '1', '5', '10', '20Plus'
      const categoryId = parts[5];
      userStates[userId] = { state: 'adm_waiting_for_tier_price_input', categoryId: categoryId, tier: tier };
      await bot.sendMessage(chatId, `⌨️ Enter the **price per code** for the ${tier} codes tier of ₹${categories.find(c => c.CategoryID === categoryId).Value} voucher. (e.g., 35.50)`, { parse_mode: 'Markdown' });
  } else if (data === 'adm_bc_prompt') {
      userStates[userId] = { state: 'adm_waiting_for_broadcast_message' };
      await bot.sendMessage(chatId, "📢 **Broadcast Message**\n\nPlease send the message you want to broadcast to all users. (Supports Markdown)", { parse_mode: 'Markdown' });
  } else if (data === 'adm_dm_prompt') {
      userStates[userId] = { state: 'adm_waiting_for_dm_target_id' };
      await bot.sendMessage(chatId, "💬 **Direct Message User**\n\nEnter the Telegram User ID of the recipient:", { parse_mode: 'Markdown' });
  } else if (data === 'adm_block_prompt') {
      userStates[userId] = { state: 'adm_waiting_for_block_id' };
      await bot.sendMessage(chatId, "🚫 **Block/Unblock User**\n\nEnter the Telegram User ID you want to block or unblock:", { parse_mode: 'Markdown' });
  }
});


// --- General Message Handler (for text input) ---
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userState = userStates[userId];

  // --- Capcha Handling (priority 1) ---
  if (userState && userState.state === 'waiting_for_captcha') {
    const userAnswer = parseInt(msg.text);
    if (!isNaN(userAnswer) && userAnswer === userState.answer) {
      delete userStates[userId];
      await bot.sendMessage(chatId, "✅ **Verified Successfully!**", { parse_mode: 'Markdown' });

      const users = await getSheetRows('Users');
      const userRecord = users.find(u => u.UserID == userId.toString());

      if (userRecord) {
        await updateSheetRow('Users', 'UserID', userId.toString(), { Status: 'Active', Verified: 'Yes', Date: new Date().toLocaleString() });
      } else {
        await appendSheetRow('Users', [userId.toString(), msg.from.first_name, new Date().toLocaleString(), 'Active', 'Yes', '', '']);
      }
      return showMainMenu(chatId);
    } else {
      await bot.sendMessage(chatId, "❌ Wrong answer. Please try again.", { parse_mode: 'Markdown' });
      return sendCaptcha(chatId, userId);
    }
  }

  // --- Custom Quantity Input Handling (priority 2) ---
  else if (userState && userState.state === 'waiting_for_custom_qty_input') {
    const qty = parseInt(msg.text);
    if (!isNaN(qty) && qty > 0) {
      delete userStates[userId];
      return processQuantityAndShowPayment(chatId, userId, userState.categoryId, qty);
    } else {
      await bot.sendMessage(chatId, "❌ Invalid number. Please enter a valid quantity.", { parse_mode: 'Markdown' });
      userStates[userId].state = 'waiting_for_custom_qty_input';
    }
  }
  
  // --- Payment Submission Flow (priority 3) ---
  else if (userState && userState.state === 'waiting_for_screenshot') {
    if (msg.photo && msg.photo.length > 0) {
      userStates[userId].proofId = msg.photo[msg.photo.length - 1].file_id;
      userStates[userId].state = 'waiting_for_utr';
      await bot.sendMessage(chatId, "✅ Screenshot received! Now, please send your **12-digit UPI Transaction ID / UTR Number**:", { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(chatId, "❌ That was not a photo. Please send a screenshot of your payment.", { parse_mode: 'Markdown' });
      userStates[userId].state = 'waiting_for_screenshot';
    }
  } else if (userState && userState.state === 'waiting_for_utr') {
    const utr = msg.text.trim();
    if (utr.length === 12 && !isNaN(parseInt(utr))) {
      delete userStates[userId].state;
      return submitOrder(chatId, userId, utr, msg.from.first_name);
    } else {
      await bot.sendMessage(chatId, "❌ Invalid UTR. Please enter a 12-digit number.", { parse_mode: 'Markdown' });
      userStates[userId].state = 'waiting_for_utr';
    }
  }

  // --- Recover Vouchers Flow (priority 4) ---
  else if (userState && userState.state === 'waiting_for_recovery_oid') {
    const orderId = msg.text.trim();
    const orders = await getSheetRows('Orders');
    const order = orders.find(o => o.OrderID === orderId);

    if (!order || order.UserID !== userId.toString()) {
        bot.sendMessage(chatId, `⚠️ **Order not found!**\nThe ID \`${orderId}\` does not exist in your orders.`, { parse_mode: 'Markdown' });
    } else if (order.Status === 'Successful') {
        bot.sendMessage(chatId, `✅ **Vouchers Found!**\nOrder ID: \`${orderId}\`\nCodes: \`${order.VoucherCodeDelivered}\``, { parse_mode: 'Markdown' });
    } else {
        bot.sendMessage(chatId, `⏳ Status: **${order.Status}**\nAdmin is currently verifying your payment.`, { parse_mode: 'Markdown' });
    }
    delete userStates[userId];
  }

  // --- Support Flow (priority 5) ---
  else if (userState && userState.state === 'in_support_mode') {
      if (msg.text === '/cancel') return; // Handled by /cancel command

      if (msg.photo && msg.photo.length > 0) {
          await bot.sendPhoto(ADMIN_ID, msg.photo[msg.photo.length - 1].file_id, {
              caption: `🆘 **Support Msg (Photo)** from ${msg.from.first_name} (\`${userId}\`):\n\n${msg.caption || ''}`,
              parse_mode: 'Markdown'
          });
      } else {
          await bot.sendMessage(ADMIN_ID, `🆘 **Support Msg** from ${msg.from.first_name} (\`${userId}\`):\n\n${msg.text || ''}`, { parse_mode: 'Markdown' });
      }
      await bot.sendMessage(chatId, "✅ Your message has been forwarded to Admin.", { parse_mode: 'Markdown' });
      return;
  }
  
  // --- Admin Inputs (priority 6) ---
  else if (userId === ADMIN_ID) { // Only admin messages are processed here for admin states
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
          await appendSheetRow('Categories', [categoryId, value.toString(), price.toFixed(2), price.toFixed(2), price.toFixed(2), price.toFixed(2), price.toFixed(2), '0', '']); // ID, Value, Price1, Price2, Price3, Price4, Price5, Price10, Price20Plus, Stock, VoucherCodes
          delete userStates[userId];
          await bot.sendMessage(chatId, `✅ **New Category ₹${value} Created!**\nDefault Price: ₹${price.toFixed(2)}.\n\nDon't forget to add stock and set tiered pricing!`, { parse_mode: 'Markdown' });
          return bot.onText(/\/admin/, async (adminMsg) => { bot.emit('message', adminMsg); })(msg); // Simulate /admin command
      } else if (userState && userState.state === 'adm_waiting_for_voucher_codes') {
          const categoryId = userState.categoryId;
          const newCodes = msg.text.split(/[\n,]+/).map(s => s.trim()).filter(s => s.length > 0);
          
          const categories = await getSheetRows('Categories');
          const cat = categories.find(c => c.CategoryID === categoryId);
          if (cat) {
              const currentVouchers = cat.VoucherCodes ? cat.VoucherCodes.split('\n').filter(c => c.trim().length > 0) : [];
              const updatedVouchers = currentVouchers.concat(newCodes);
              await updateSheetRow('Categories', 'CategoryID', categoryId, { VoucherCodes: updatedVouchers.join('\n'), Stock: updatedVouchers.length.toString() });
              bot.sendMessage(chatId, `✅ Added ${newCodes.length} codes to ${categoryId}. New stock: ${updatedVouchers.length}.`, { parse_mode: 'Markdown' });
          } else {
              bot.sendMessage(chatId, "❌ Category not found for stock update.", { parse_mode: 'Markdown' });
          }
          delete userStates[userId];
          return bot.onText(/\/admin/, async (adminMsg) => { bot.emit('message', adminMsg); })(msg);
      } else if (userState && userState.state === 'adm_waiting_for_code_to_remove') {
          const codeToRemove = msg.text.trim();
          const categories = await getSheetRows('Categories');
          let codeRemoved = false;
          for (const cat of categories) {
              let voucherCodes = cat.VoucherCodes ? cat.VoucherCodes.split('\n').filter(c => c.trim().length > 0) : [];
              const initialLength = voucherCodes.length;
              voucherCodes = voucherCodes.filter(code => code !== codeToRemove);
              if (voucherCodes.length < initialLength) { // Code was found and removed
                  await updateSheetRow('Categories', 'CategoryID', cat.CategoryID, { VoucherCodes: voucherCodes.join('\n'), Stock: voucherCodes.length.toString() });
                  bot.sendMessage(chatId, `✅ Code \`${codeToRemove}\` removed from ${cat.CategoryID}.`, { parse_mode: 'Markdown' });
                  codeRemoved = true;
                  break;
              }
          }
          if (!codeRemoved) {
              bot.sendMessage(chatId, `❌ Code \`${codeToRemove}\` not found in any category.`, { parse_mode: 'Markdown' });
          }
          delete userStates[userId];
          return bot.onText(/\/admin/, async (adminMsg) => { bot.emit('message', adminMsg); })(msg);
      } else if (userState && userState.state === 'adm_waiting_for_broadcast_message') {
          await bot.sendMessage(chatId, "📢 Sending broadcast now...", { parse_mode: 'Markdown' });
          const users = await getSheetRows('Users');
          for (const userRow of users) {
              try {
                  await bot.sendMessage(parseInt(userRow.UserID), `📢 **Broadcast Message**\n\n${msg.text}`, { parse_mode: 'Markdown' });
              } catch (error) {
                  console.error(`Failed to send broadcast to ${userRow.UserID}: ${error.message}`);
              }
          }
          await bot.sendMessage(chatId, "✅ Broadcast sent to all users.", { parse_mode: 'Markdown' });
          delete userStates[userId];
          return bot.onText(/\/admin/, async (adminMsg) => { bot.emit('message', adminMsg); })(msg);
      } else if (userState && userState.state === 'adm_waiting_for_dm_target_id') {
          const targetId = parseInt(msg.text);
          if (isNaN(targetId)) {
              bot.sendMessage(chatId, "❌ Invalid User ID. Please enter a valid number.", { parse_mode: 'Markdown' });
              return;
          }
          userStates[userId].dmTargetId = targetId;
          userStates[userId].state = 'adm_waiting_for_dm_message';
          await bot.sendMessage(chatId, `✅ User ID set to \`${targetId}\`.\n\nNow, type the message you want to send:`, { parse_mode: 'Markdown' });
      } else if (userState && userState.state === 'adm_waiting_for_dm_message') {
          const targetId = userStates[userId].dmTargetId;
          try {
              await bot.sendMessage(targetId, `📩 **Message from Admin:**\n\n${msg.text}`, { parse_mode: 'Markdown' });
              bot.sendMessage(chatId, `✅ Message sent to User ID: \`${targetId}\`.`, { parse_mode: 'Markdown' });
          } catch (error) {
              bot.sendMessage(chatId, `❌ Failed to send message to User ID: \`${targetId}\`. Error: ${error.message}`, { parse_mode: 'Markdown' });
          }
          delete userStates[userId];
          return bot.onText(/\/admin/, async (adminMsg) => { bot.emit('message', adminMsg); })(msg);
      } else if (userState && userState.state === 'adm_waiting_for_block_id') {
          const targetId = parseInt(msg.text);
          if (isNaN(targetId)) {
              bot.sendMessage(chatId, "❌ Invalid User ID. Please enter a valid number.", { parse_mode: 'Markdown' });
              return;
          }
          const users = await getSheetRows('Users');
          const userToBlock = users.find(u => u.UserID == targetId.toString());
          if (userToBlock) {
              const newStatus = userToBlock.Status === 'Blocked' ? 'Active' : 'Blocked';
              await updateSheetRow('Users', 'UserID', targetId.toString(), { Status: newStatus });
              bot.sendMessage(chatId, `✅ User ID \`${targetId}\` status changed to **${newStatus}**.`, { parse_mode: 'Markdown' });
          } else {
              bot.sendMessage(chatId, `❌ User ID \`${targetId}\` not found in database.`, { parse_mode: 'Markdown' });
          }
          delete userStates[userId];
          return bot.onText(/\/admin/, async (adminMsg) => { bot.emit('message', adminMsg); })(msg);
      }
  }

  // --- Fallback for Unrecognized Messages (outside specific states) ---
  else if (!msg.text.startsWith('/') && msg.text !== '/cancel' && !msg.text.startsWith('🛍️') && !msg.text.startsWith('📦') && !msg.text.startsWith('🔄') && !msg.text.startsWith('🆘') && !msg.text.startsWith('📜')) {
    await bot.sendMessage(chatId, "I don't understand that. Please use the menu buttons or commands.", { parse_mode: 'Markdown' });
    await showMainMenu(chatId); // Display main menu
  }
});
