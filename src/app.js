import dotenv from 'dotenv';
dotenv.config();

import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import { MongoClient } from 'mongodb';
import TelegramBot from 'node-telegram-bot-api';
import { CronJob } from 'cron';
import { DateTime } from 'luxon';
import { ChatGPTAPI } from 'chatgpt';
import retry from 'async-retry';
import puppeteer from 'puppeteer';
import winston from 'winston';


const DB_NAME = process.env.DB_NAME || 'shekelStreamer';
const TRANSACTIONS_COLLECTION_NAME = process.env.TRANSACTIONS_COLLECTION_NAME || 'transactions';
const TRANSLATIONS_COLLECTION_NAME = process.env.TRANSLATIONS_COLLECTION_NAME || 'translations';
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Jerusalem';

const logger = configureLogger();

logger.info('Starting Shekel Streamer...');

const isTranslationEnabled = process.env.OPENAI_API_KEY && process.env.GPT_MODEL_FAST
  && process.env.GPT_TRANSLATION_PROMPT && process.env.GPT_TRANSLATION_PROMPT.includes('<text_to_replace>');

if (!isTranslationEnabled) {
  logger.info('No OpenAI API key or GPT model or GPT translation prompt found. Translation is disabled.');
}

checkMongoDB(process.env.MONGO_CONNECTION_STRING)
  .then(result => {
    if (result) {
      initializeSyncTasks();
    } else {
      process.exit(1);
    }
  });

// End of main code

/**
 * Initialize and run transaction synchronization tasks.
 * If SYNC_ON_STARTUP is true, runs tasks on startup.
 * If SYNC_ON_SCHEDULE is true, schedules tasks according to SYNC_SCHEDULE.
 * 
 * @returns {Promise<void>}
 */
async function initializeSyncTasks() {
  const transactionSyncTasks = getTransactionSyncTasks();
  if (transactionSyncTasks.length === 0) {
    logger.info('No transaction sync tasks found. Exiting.');
    process.exit(0);
  }

  const isScheduled = process.env.SYNC_ON_SCHEDULE === 'true' && process.env.SYNC_SCHEDULE

  // Run sync on startup if it's configured
  if (process.env.SYNC_ON_STARTUP === 'true') {
    await processTransactionSyncTasks(transactionSyncTasks)
    if (!isScheduled) {
      logger.info('Sync on schedule is disabled. Exiting.');
      process.exit(0);
    }
  } else if (!isScheduled) {
    logger.info('Sync on startup and schedule are disabled. Exiting.');
    process.exit(0);
  }

  // Schedule cron job for this user and company if it's configured
  if (isScheduled) {
    const scheduledTask = new CronJob(process.env.SYNC_SCHEDULE, async function () {
      try {
        await processTransactionSyncTasks(transactionSyncTasks);
      } catch (error) {
        logger.error(`Sync failed`, { errorMessage: error.message, errorStack: error.stack });
      }
      logger.info(`Next scheduled sync: ${timezoned(this.nextDate())}`);
    }, null, false, DEFAULT_TIMEZONE); // Don't start the job right now

    scheduledTask.start();

    logger.info(`Next scheduled sync: ${timezoned(scheduledTask.nextDate())}`);
  }
}

/**
 * Function to get ISO string with timezone set to DEFAULT_TIMEZONE
 * @param {DateTime} dateTime Luxon DateTime object
 * @returns {string} ISO string with timezone set to DEFAULT_TIMEZONE
 */
function timezoned(dateTime) {
  return dateTime.setZone(DEFAULT_TIMEZONE).toFormat('yyyy-MM-dd\'T\'HH:mm:ssZZ');
}

/**
 * Function to configure logger using Winston
 */
function configureLogger() {
  const transports = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(info => {
          const { timestamp, level, message, ...rest } = info;
          return `${timestamp} ${level}: ${message}${(Object.keys(rest).length > 0) ? ' ' + JSON.stringify(rest) : ''}`
        })
      )
    })
  ];

  // Log to files only if not running in Docker because of permission issues with Docker volumes
  // Use Docker logging instead (docker-compose logs -f, for example)
  if (!process.env.DOCKER) {
    transports.push(
      new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
      new winston.transports.File({ filename: 'logs/combined.log' })
    );
  }

  return winston.createLogger({
    level: 'info',
    format: winston.format.combine(
      winston.format.timestamp({
        format: () => timezoned(DateTime.local())
      }),
      winston.format.errors({ stack: true }),
      winston.format((info) => {
        const { timestamp, level, message, ...rest } = info;
        return { timestamp, level, message, ...rest };
      })(),
      winston.format.json({ deterministic: false })
    ),
    transports
  });
}

/**
 * Formats transaction date and removes time if it's 00:00:00
 * @param {string} jsDate 
 * @returns The formatted date string in the DEFAULT_TIMEZONE
 */
function formatDateTime(jsDate) {
  let dateTime = DateTime.fromJSDate(jsDate, { zone: 'Asia/Jerusalem' });

  // If time equals 00:00:00, format without time
  if (dateTime.hour === 0 && dateTime.minute === 0 && dateTime.second === 0) {
    return dateTime.toFormat('yyyy-MM-dd');
  }

  // Re-parse the dateTime in the DEFAULT_TIMEZONE
  return dateTime.setZone(DEFAULT_TIMEZONE).toFormat('yyyy-MM-dd HH:mm:ss');
}

/**
 * Function to format transaction for Telegram
 * @param {any} transaction 
 * @returns {string} Formatted transaction
 */
function format(transaction) {
  let date = formatDateTime(transaction.date);
  let processedDate = formatDateTime(transaction.processedDate);

  const chargedAmount = new Intl.NumberFormat('he-IL', { style: 'currency', currency: transaction.originalCurrency }).format(transaction.chargedAmount);
  const incomeOrExpenseEmoji = transaction.chargedAmount > 0 ? '💰' : '💸'; // 💰 for income, 💸 for expense
  let description = transaction.memo ? `${transaction.description} - ${transaction.memo}` : transaction.description;

  return `
Acccount: *${transaction.accountNumber} ${incomeOrExpenseEmoji}*
Amount: *${chargedAmount}*
Description: *${description}*${transaction.translatedDescription ? `\nDescription (EN): *${transaction.translatedDescription}*` : ''}
Date: *${date}*${transaction.identifier ? `\nId: *${transaction.identifier}*` : ''}

Processed Date: ${processedDate}
Type: ${transaction.type}
Status: ${transaction.status}
`;
}

/**
 * Function to translate transactions' descriptions using OpenAI Chat API
 * @param {string[]} descriptions
 * @returns {Promise<string[]>} Translated descriptions
 */
async function translateDescriptions(descriptions) {
  const placeholder = '<text_to_replace>';

  if (!isTranslationEnabled) {
    return descriptions.map(_ => null);
  }

  const api = new ChatGPTAPI({
    apiKey: process.env.OPENAI_API_KEY,
    completionParams: {
      model: process.env.GPT_MODEL_FAST,
      temperature: 0.2 // for stable results
    }
  });

  // Join all descriptions into one string
  const descriptionsString = descriptions.join('\n');

  const request = process.env.GPT_TRANSLATION_PROMPT.replace(/\\n/g, '\n').replace(placeholder, descriptionsString);
  const response = await api.sendMessage(request)

  // Note: response can include extra translanslation in the the beginning. Details are below.
  logger.info("Translation result was received", { request: descriptionsString, response: response.text });

  // Split the text into lines and obtain translations from the response in the format:
  // "translate1
  // translate2"
  // Note: The first line of the response corresponds to the translation of the first phrase from the request.
  // This is why the first line is ignored (traslations.slice(1)).
  // This is done to form a list of phrases that can be more clearly understood by the GPT when there is only one phrase.
  let traslations = response.text.split('\n').map(translation => translation.trim());
  if (traslations.length !== descriptions.length + 1) {
    const errorMessage = `Number of translations (${traslations.length}) does not match number of descriptions (${descriptions.length})`;
    logger.warn(errorMessage, { descriptions, traslations });
    throw new Error(errorMessage);
  }

  return traslations.slice(1);
}

/**
 * Function to put translation to cache
 * @param {string} description
 * @param {string} translation
 */
async function setTranslationToCache(description, translation) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const translations = database.collection(TRANSLATIONS_COLLECTION_NAME);

    try {
      await translations.insertOne({ _id: description, translation: translation });
    } catch (error) {
      if (error.code !== 11000) { // Ignore duplicate key error
        throw error;
      }
    }
  } finally {
    await client.close();
  }
}

/**
 * Function to get translation from cache
 * @param {string} description
 * @returns {Promise<string>} Cached translation
 */
async function getTranslationFromCache(description) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const translations = database.collection(TRANSLATIONS_COLLECTION_NAME);
    const doc = await translations.findOne({ _id: description });
    return doc ? doc.translation : null;
  } finally {
    await client.close();
  }
}


/**
 * Function to get list of translations for given descriptions from cache or OpenAI Chat API
 * @param {any[]} transaction
 * @returns {Promise<string[]>} Translated descriptions
 */
async function getTranslations(transactions) {
  const descriptionsToTranslate = transactions.map(transaction => {
    return transaction.memo ? `${transaction.description} - ${transaction.memo}` : transaction.description;
  });

  let translations = [];
  let uniqueNotCachedDescrs = new Set();
  let cachedTranslations = {};

  for (const description of descriptionsToTranslate) {
    let cachedTranslation = await getTranslationFromCache(description);
    if (cachedTranslation) {
      cachedTranslations[description] = cachedTranslation;
    } else {
      uniqueNotCachedDescrs.add(description);
    }
  }

  uniqueNotCachedDescrs = Array.from(uniqueNotCachedDescrs);

  if (uniqueNotCachedDescrs.length > 0) {
    try {
      const newTranslations = await retry(async () => {
        return await translateDescriptions(uniqueNotCachedDescrs);
      }, {
        retries: 5,
        factor: 2,
        minTimeout: 20000,
        randomize: true
      });

      for (let i = 0; i < uniqueNotCachedDescrs.length; i++) {
        await setTranslationToCache(uniqueNotCachedDescrs[i], newTranslations[i]);
        cachedTranslations[uniqueNotCachedDescrs[i]] = newTranslations[i];
      }
    } catch (error) {
      logger.error(`Failed to translate descriptions`,
        { descriptions: uniqueNotCachedDescrs, errorMessage: error.message, errorStack: error.stack });
    }
  }

  // Form a list of translations in the same order as the list of transactions
  translations = descriptionsToTranslate.map(description => cachedTranslations[description]);

  return translations;
}


/**
 * Function to get existing transactions from db (by date, chargedAmount, description, processedDate, status and translatedDescription)
 * @param {any} transactions 
 * @returns {Promise<any[]>} Set of transaction keys (date+chargedAmount+description+processedDate+status)
 */
async function getExistingTransactions(transactions) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  if (transactions.length === 0) {
    return new Set();
  }

  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const transCollection = database.collection(TRANSACTIONS_COLLECTION_NAME);

    const query = {
      $or: transactions.map(transaction => ({
        date: transaction.date,
        chargedAmount: transaction.chargedAmount,
        description: transaction.description,

        // following fields will update if transaction already exists, so we need to check them too
        processedDate: transaction.processedDate,
        status: transaction.status,
        translatedDescription: { $not: { $eq: null } }
      }))
    };

    const cursor = transCollection.find(query);
    const existingTransactions = new Set();

    for await (const doc of cursor) {
      existingTransactions.add(doc.date + doc.chargedAmount + doc.description + doc.processedDate + doc.status);
    }

    return existingTransactions;

  } finally {
    await client.close();
  }
}

/**
 * Function to save or update transaction in db
 * @param {any} transaction 
 * @returns {Promise<boolean>} true if transaction was inserted, false if transaction already exists
 */
async function saveOrUpdate(transaction) {
  const client = new MongoClient(process.env.MONGO_CONNECTION_STRING);
  try {
    await client.connect();
    const database = client.db(DB_NAME);
    const transCollection = database.collection(TRANSACTIONS_COLLECTION_NAME);

    // Check if transaction already exists
    const existingTransaction = await transCollection.findOne({
      date: transaction.date,
      chargedAmount: transaction.chargedAmount,
      description: transaction.description
    });

    if (existingTransaction) {
      // Transaction exists, update it
      await transCollection.updateOne(
        {
          date: transaction.date,
          chargedAmount: transaction.chargedAmount,
          description: transaction.description
        },
        {
          $set: transaction,
          $currentDate: { updatedAt: true } // Add or update a updatedAt field with the current date
        }
      );

      return false;
    } else {
      transaction.createdAt = new Date(); // Add a createdAt field with the current date
      await transCollection.insertOne(transaction);

      return true;
    }
  } finally {
    await client.close();
  }
}

/**
 * Function to check MongoDB availability
 * 
 * @param {string} uri MongoDB connection string
 * @returns {Promise<boolean>} true if MongoDB is available, false otherwise
 */
async function checkMongoDB(uri) {
  let client
  try {
    client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true });
    await client.connect();
    return true;
  } catch (error) {
    console.error('Failed to connect to MongoDB.', { errorMessage: error.message, errorStack: error.stack });
    return false;
  } finally {
    if (client) {
      await client.close();
    }
  }
}

/**
 * Function to send transaction to Telegram chat with retries
 * @param {any} transaction
 * @param {string} chatId Telegram chat ID
 */
async function notify(transaction, chatId) {
  if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
    logger.info('No Telegram bot token or chat ID found. Skipping notification.');
    return;
  }

  const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

  try {
    await retry(async () => {
      await bot.sendMessage(chatId, format(transaction), { parse_mode: 'Markdown' });
    }, {
      retries: 5,
      minTimeout: 30 * 1000, // 30 seconds
      randomize: true,
    });
  } catch (error) {
    // If the request still fails after all retries, log the error
    logger.error(`Failed to send message to Telegram`,
      { transactionDbId: transaction._id, chatId, errorMessage: error.message, errorStack: error.stack });
  }
}

/**
 * Function to sync bank transactions, store to MongoDB and send to Telegram chat
 * @param {any} taskKey { user: string, company: CompanyTypes }
 * @param {any} credentials Credentials for the financial service
 * @param {string} chatId Telegram chat ID
 */
async function handleTransactions(taskKey, credentials, chatId) {

  const daysCount = Number(process.env.SYNC_DAYS_COUNT) || 7;
  const initialSyncDate = new Date(new Date().setDate(new Date().getDate() - daysCount));

  logger.info(`Sync started...`, { ...taskKey, initialSyncDate: DateTime.fromJSDate(initialSyncDate).toISODate() });

  let scraperOptions = {
    companyId: taskKey.company,
    startDate: initialSyncDate,
    combineInstallments: false,
    timeout: 0, // no timeout
  }

  if (process.env.DOCKER === 'true') {
    scraperOptions.browser = await puppeteer.launch({
      headless: "new",
      executablePath: '/usr/bin/chromium-browser',
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-setuid-sandbox",
        "--no-sandbox",
      ]
    })
  }

  const syncResult = await createScraper(scraperOptions).scrape(credentials);

  if (syncResult.success) {
    let transactions = [];
    syncResult.accounts.forEach((account) => {
      account.txns.forEach((txn) => {
        transactions.push({
          accountNumber: account.accountNumber,
          date: new Date(txn.date),
          description: txn.description,
          translatedDescription: null, // will be filled later
          memo: txn.memo, // can be null
          originalAmount: txn.originalAmount,
          originalCurrency: txn.originalCurrency, // possible wrong value: ILS instead of USD
          chargedAmount: txn.chargedAmount, // possible the same as originalAmount, even if originalCurrency is USD/EUR
          type: txn.type,
          status: txn.status,
          identifier: txn.identifier, // can be null
          processedDate: new Date(txn.processedDate),
          installments: txn.installments, // can be null
          companyId: taskKey.company,
          userCode: taskKey.user,
          chatId: chatId
        });
      });
    });

    if (transactions.length === 0) {
      logger.info(`No transactions found.`, taskKey);
      return;
    }

    logger.info(`Total transactions found: ${transactions.length}`, taskKey);

    // Sort transactions by date from oldest to newest
    transactions.sort((a, b) => a.date - b.date)

    const existingTransactions = await getExistingTransactions(transactions);

    // Filter out the transactions that already exist in the db and don't need to be updated
    if (existingTransactions.size > 0) {
      transactions = existingTransactions.size > 0 ? transactions.filter(transaction => {
        const key = transaction.date + transaction.chargedAmount + transaction.description + transaction.processedDate + transaction.status;
        return !existingTransactions.has(key);
      }) : transactions;
    }

    let counters = {
      new: 0,
      updated: 0
    };

    const chunkSize = Number(process.env.GPT_TRANSLATION_COUNT) || 30;
    let chunkCount = Math.ceil(transactions.length / chunkSize);

    for (let i = 0; i < chunkCount; i++) {

      let currentTransactions = transactions.slice(i * chunkSize, (i + 1) * chunkSize);

      // Create a list of descriptions to translate
      const translations = await getTranslations(currentTransactions);

      // Assign translations back to current transactions
      currentTransactions.forEach((transaction, index) => {
        transaction.translatedDescription = translations[index];
      });

      for (const transaction of currentTransactions) {
        const isNewTransaction = await saveOrUpdate(transaction);

        // Send notification only if transaction is new
        if (isNewTransaction) {
          counters.new++;
          await notify(transaction, chatId);
        } else {
          counters.updated++;
        }
      }
    }

    logger.info(`Sync finished. New: ${counters.new}, updated: ${counters.updated}`, taskKey);
  } else {
    logger.error(`Sync failed`,
      { ...taskKey, errorType: syncResult.errorType, errorMessage: syncResult.errorMessage });
  }
}

/**
 * Function to find key in object, case insensitive
 * @param {any} object 
 * @param {string} targetKey
 * @returns {string} Key of the object that matches the target key, case insensitive
 */
function findKeyCaseInsensitive(object, targetKey) {
  const lowerCaseTargetKey = targetKey.toLowerCase();
  for (const key in object) {
    if (key.toLowerCase() === lowerCaseTargetKey) {
      return key;
    }
  }
  return null;
}

/**
 * Get tasks for sync transactions
 * @returns {Array} Array of tasks to be executed
 */
function getTransactionSyncTasks() {
  const transactionSyncTasks = [];

  const users = process.env.USERS.split(',');
  users.forEach((user) => {
    // Get environment variables for this user
    const userEnvVars = Object.keys(process.env).filter(
      key => key.startsWith(`${user}_`) && !key.startsWith(`${user}_TELEGRAM`)
    );

    // Get unique company names from user's environment variables
    const companies = [...new Set(userEnvVars.map(key => key.split('_')[1]))];

    companies.forEach((company) => {
      const credentials = {
        id: process.env[`${user}_${company}_ID`],
        num: process.env[`${user}_${company}_NUM`],
        username: process.env[`${user}_${company}_USERNAME`],
        userCode: process.env[`${user}_${company}_USER_CODE`],
        password: process.env[`${user}_${company}_PASSWORD`],
        card6Digits: process.env[`${user}_${company}_CARD6DIGITS`],
        nationalID: process.env[`${user}_${company}_NATIONAL_ID`],
      };

      const chatId = process.env[`${user}_${company}_TELEGRAM_CHANNEL_ID`] || process.env[`${user}_TELEGRAM_CHANNEL_ID`];

      // Get CompanyTypes key from config company name
      const companyTypeKey = findKeyCaseInsensitive(CompanyTypes, company);
      if (!companyTypeKey) {
        logger.error(`Unknown company: ${company}`);
        return;
      }

      const taskKey = { user, company: CompanyTypes[companyTypeKey] };

      // Push the flat task object into the array
      transactionSyncTasks.push({
        taskKey: taskKey,
        credentials: credentials,
        chatId: chatId
      });
    });
  });

  return transactionSyncTasks;
}

/**
 * Processes the given transaction sync tasks sequentially.
 */
async function processTransactionSyncTasks(transactionSyncTasks) {
  for (const task of transactionSyncTasks) {
    try {
      await handleTransactions(task.taskKey, task.credentials, task.chatId);
    } catch (error) {
      logger.error(`Sync failed`, { ...task.taskKey, errorMessage: error.message, errorStack: error.stack });
    }
  }
}
