#!/usr/bin/env node
import { program } from 'commander';
import inquirer from 'inquirer';
import ora from 'ora';
import chalk from 'chalk';
import { detectPlugoEndpoint } from './detector.js';
import { StockPoller } from './poller.js';
import { Display } from './display.js';
import { exportToCsv } from './exporter.js';

program
  .name('plugo-bot')
  .description('Realtime stock monitor for Plugo-based streetwear stores')
  .argument('[urls...]', 'One or more Plugo product URLs to monitor')
  .option('-i, --interval <ms>', 'Poll interval in milliseconds', '5000')
  .option('-v, --verbose', 'Show detection debug logs')
  .parse(process.argv);

const opts = program.opts();
let urls = program.args;

// ─── Interactive URL input if none provided ──────────────────────────────────
if (urls.length === 0) {
  console.log(chalk.cyan('\nPlugo Stock Monitor\n'));
  const { raw } = await inquirer.prompt([
    {
      type: 'input',
      name: 'raw',
      message: 'Enter product URL(s) separated by spaces or commas:',
      validate: (v) => (v.trim().length > 0 ? true : 'At least one URL is required'),
    },
  ]);
  urls = raw
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

// ─── Validate URLs ────────────────────────────────────────────────────────────
const validUrls = urls.filter((u) => {
  try {
    new URL(u);
    return true;
  } catch {
    console.warn(chalk.yellow(`Skipping invalid URL: ${u}`));
    return false;
  }
});

if (validUrls.length === 0) {
  console.error(chalk.red('No valid URLs provided. Exiting.'));
  process.exit(1);
}

const intervalMs = Math.max(1000, parseInt(opts.interval, 10) || 5000);
const display = new Display();
const pollers = [];

// Accumulated change events for CSV export
const allEvents = [];

// ─── Detection phase ──────────────────────────────────────────────────────────
console.log(chalk.bold.cyan(`\nDetecting Plugo API endpoints for ${validUrls.length} URL(s)...\n`));

const detectionResults = await Promise.allSettled(
  validUrls.map(async (url) => {
    const spinner = ora({
      text: chalk.gray(`Scanning ${url}`),
      spinner: 'dots',
    }).start();

    const logs = [];
    const log = (msg) => {
      logs.push(msg);
      if (opts.verbose) spinner.text = chalk.gray(msg);
    };

    try {
      const result = await detectPlugoEndpoint(url, log);

      if (!result) {
        spinner.fail(chalk.red(`No stock API found for ${url}`));
        if (opts.verbose) logs.forEach((l) => console.log(chalk.gray('  ' + l)));
        return null;
      }

      spinner.succeed(
        chalk.green(`Found API: `) + chalk.white(result.apiUrl)
      );

      if (opts.verbose) logs.forEach((l) => console.log(chalk.gray('  ' + l)));
      return { productUrl: url, ...result };
    } catch (err) {
      spinner.fail(chalk.red(`Detection failed for ${url}: ${err.message}`));
      if (opts.verbose) logs.forEach((l) => console.log(chalk.gray('  ' + l)));
      return null;
    }
  })
);

const detected = detectionResults
  .filter((r) => r.status === 'fulfilled' && r.value !== null)
  .map((r) => r.value);

if (detected.length === 0) {
  console.error(chalk.red('\nCould not detect any Plugo API endpoints. Exiting.'));
  process.exit(1);
}

console.log(chalk.bold.green(`\nMonitoring ${detected.length}/${validUrls.length} product(s). Starting...\n`));

// ─── Seed display with initial data ──────────────────────────────────────────
for (const { productUrl, initial } of detected) {
  display.addProduct(productUrl, initial.productName, initial.variants);
}

// ─── Start pollers ────────────────────────────────────────────────────────────
for (const { productUrl, apiUrl, initial } of detected) {
  const poller = new StockPoller({ productUrl, apiUrl, initial, intervalMs });

  poller.on('update', ({ productUrl, data, changes, timestamp }) => {
    display.upsert(productUrl, data.productName, data.variants, changes, timestamp);

    for (const c of changes) {
      allEvents.push({
        timestamp,
        productUrl,
        productName: data.productName,
        variant: c.label,
        oldStock: c.oldStock,
        newStock: c.newStock,
        changeType: c.type,
      });
    }
  });

  poller.on('error', ({ productUrl, error }) => {
    display.setError(productUrl, error);
  });

  poller.start();
  pollers.push(poller);
}

// ─── Initial render ───────────────────────────────────────────────────────────
display.render();

// ─── Shutdown handler ─────────────────────────────────────────────────────────
let exiting = false;

async function shutdown() {
  if (exiting) return;
  exiting = true;

  console.log(chalk.bold.cyan('\n\nStopping monitors...'));
  pollers.forEach((p) => p.stop());

  if (allEvents.length === 0) {
    console.log(chalk.gray('No stock changes recorded — skipping CSV export.'));
    process.exit(0);
  }

  const exportSpinner = ora('Exporting stock changes to CSV...').start();
  try {
    const filepath = await exportToCsv(allEvents);
    exportSpinner.succeed(
      chalk.green(`Exported ${allEvents.length} change event(s) → `) + chalk.bold.white(filepath)
    );
  } catch (err) {
    exportSpinner.fail(chalk.red(`CSV export failed: ${err.message}`));
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
