import chalk from 'chalk';
import Table from 'cli-table3';

const CHANGE_ICONS = {
  soldout: chalk.red('▼ SOLD OUT'),
  restock: chalk.green('▲ RESTOCK'),
  change: chalk.yellow('● CHANGE'),
  new: chalk.blue('+ NEW'),
};

// Maximum change history lines shown per product
const MAX_HISTORY = 6;

export class Display {
  constructor() {
    // Map of productUrl -> { data, changes: [], errors, lastUpdated }
    this.entries = new Map();
    this.startedAt = new Date();
    this._redrawScheduled = false;
  }

  upsert(productUrl, productName, variants, changes, timestamp) {
    const existing = this.entries.get(productUrl) ?? { history: [], errors: 0 };

    for (const c of changes) {
      existing.history.unshift({
        ...c,
        at: timestamp,
      });
    }
    if (existing.history.length > MAX_HISTORY) {
      existing.history.length = MAX_HISTORY;
    }

    this.entries.set(productUrl, {
      productName,
      variants,
      history: existing.history,
      errors: existing.errors,
      lastUpdated: timestamp,
    });

    this._scheduleRedraw();
  }

  setError(productUrl, message) {
    const existing = this.entries.get(productUrl) ?? { history: [] };
    existing.errors = (existing.errors ?? 0) + 1;
    existing.lastError = message;
    this.entries.set(productUrl, existing);
    this._scheduleRedraw();
  }

  addProduct(productUrl, productName, variants) {
    const existing = this.entries.get(productUrl) ?? {};
    this.entries.set(productUrl, {
      productName,
      variants,
      history: [],
      errors: 0,
      ...existing,
      lastUpdated: new Date(),
    });
    this._scheduleRedraw();
  }

  _scheduleRedraw() {
    if (this._redrawScheduled) return;
    this._redrawScheduled = true;
    setImmediate(() => {
      this._redrawScheduled = false;
      this.render();
    });
  }

  render() {
    console.clear();
    this._header();

    for (const [url, entry] of this.entries) {
      this._renderProduct(url, entry);
    }

    this._footer();
  }

  _header() {
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');

    process.stdout.write(
      chalk.bold.cyan('╔══════════════════════════════════════════════════════╗\n') +
      chalk.bold.cyan('║  ') +
      chalk.bold.white('PLUGO STOCK MONITOR') +
      chalk.gray(` v1.0  `) +
      chalk.bold.cyan('  ') +
      chalk.gray(`⏱  ${mins}:${secs} elapsed`) +
      chalk.bold.cyan('  ║\n') +
      chalk.bold.cyan('╚══════════════════════════════════════════════════════╝\n')
    );
  }

  _renderProduct(url, entry) {
    const { productName, variants = [], history = [], errors, lastUpdated, lastError } = entry;

    const ts = lastUpdated
      ? chalk.gray(lastUpdated.toLocaleTimeString())
      : chalk.gray('pending...');

    const errorBadge = errors > 0 ? chalk.red(` ⚠ ${errors} err`) : '';

    console.log(
      chalk.bold.white(`\n  ${productName}`) + errorBadge + chalk.gray(` · last polled ${ts}`)
    );
    console.log(chalk.gray(`  ${url}\n`));

    if (variants.length === 0) {
      console.log(chalk.gray('  No variant data yet.\n'));
      return;
    }

    const table = new Table({
      head: [
        chalk.bold('Size / Variant'),
        chalk.bold('Stock'),
        chalk.bold('Status'),
      ],
      colWidths: [22, 10, 20],
      style: { head: [], border: ['gray'] },
    });

    for (const { label, stock } of variants) {
      const stockStr = stock > 0 ? chalk.green(String(stock)) : chalk.red('0');
      const status =
        stock === 0
          ? chalk.red('✗ Out of stock')
          : stock <= 3
          ? chalk.yellow(`⚡ Low (${stock})`)
          : chalk.green('✓ In stock');
      table.push([label, stockStr, status]);
    }

    console.log(table.toString());

    if (history.length > 0) {
      console.log(chalk.bold.gray('  Recent changes:'));
      for (const h of history) {
        const time = chalk.gray(h.at.toLocaleTimeString());
        const icon = CHANGE_ICONS[h.type] ?? chalk.white('· UPDATE');
        const detail =
          h.oldStock === null
            ? chalk.gray(`→ ${h.newStock}`)
            : chalk.gray(`${h.oldStock} → ${h.newStock}`);
        console.log(`   ${time}  ${icon}  ${chalk.white(h.label)}  ${detail}`);
      }
    }

    if (lastError && errors > 0) {
      console.log(chalk.red(`  Last error: ${lastError}`));
    }
  }

  _footer() {
    console.log(
      '\n' +
      chalk.gray('  Monitoring every 5s · ') +
      chalk.bold.white('Ctrl+C') +
      chalk.gray(' to stop and export CSV')
    );
  }
}
