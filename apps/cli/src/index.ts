import readline from "node:readline";
import { ErrandApp, config, createDeps, slotLabel, type ForcedBookOutcome, type OutputMessage } from "@core";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

const HELP = `
${c.bold("Chat")}: just type, e.g. "Find a plumber for my kitchen tap this week, mornings only, under ₹1,500"

${c.bold("Commands")}
  /help                         show this help
  /new                          start a new session (memory and bookings persist)
  /bookings                     list your bookings
  /memory [all]                 show stored preferences (all = include forgotten)
  /forget <id|key>              forget a preference
  /confirm-memory <id>          confirm an inferred preference so the agent may use it
  /edit-memory <id> <value>     correct a preference
  /session                      show session + trace file paths

${c.bold("Simulation controls")}
  /force-book <outcome>         next book call: success | slot_taken | timeout_booked | timeout_not_booked
  /price-change <P#> <pct>      price change applied on hold, e.g. /price-change P3 0.2 (0 to disable)
  /provider-cancel <booking_id> simulate the provider cancelling a booking (agent reacts on its own)
  /exit                         quit
`;

function render(messages: OutputMessage[]) {
  for (const m of messages) {
    if (m.kind === "assistant") console.log(`\n${c.cyan("agent ›")} ${m.text}`);
    else if (m.kind === "confirmation") console.log(`\n${c.yellow("┌─ CONFIRMATION REQUIRED ─────────────────────────────")}\n${m.text.split("\n").map((l) => c.yellow("│ ") + l).join("\n")}\n${c.yellow("└─────────────────────────────────────────────────────")}`);
    else if (m.kind === "system") console.log(`\n${c.magenta("system ›")} ${m.text}`);
    else if (m.kind === "error") console.log(`\n${c.red("error ›")} ${m.text}`);
  }
}

async function main() {
  if (!config.apiKey) {
    console.error(c.red("ANTHROPIC_API_KEY is empty. Paste your key into the .env file at the repo root and run again."));
    process.exit(1);
  }

  const resume = process.argv.includes("--resume");
  const app = new ErrandApp(createDeps(), { resume });
  const hooks = { onProgress: (t: string) => console.log(c.dim(`  ↳ ${t.length > 160 ? t.slice(0, 160) + "…" : t}`)) };

  console.log(c.bold("\nErrand Agent") + c.dim(`  (model: ${config.agentModel}, intent: ${config.intentModel}, user: ${app.session.user_id})`));
  console.log(c.dim(`session: ${app.session.id}  •  type /help for commands`));

  render(await app.startup());

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `\n${c.green("you ›")} ` });
  let busy = false;
  const queue: string[] = [];

  const withBusy = async (fn: () => Promise<void>) => {
    busy = true;
    try {
      await fn();
    } catch (err) {
      console.log(c.red(`error › ${(err as Error).message}`));
    } finally {
      busy = false;
    }
  };

  const checkEvents = async () => {
    const out = await app.pollEvents(hooks);
    if (out.length) render(out);
    return out.length > 0;
  };

  async function handleCommand(line: string): Promise<boolean> {
    const [cmd, ...args] = line.split(/\s+/);
    switch (cmd) {
      case "/help":
        console.log(HELP);
        return true;
      case "/exit":
      case "/quit":
        rl.close();
        return true;
      case "/new":
        app.newSession();
        console.log(c.dim(`new session: ${app.session.id}`));
        return true;
      case "/session":
        console.log(c.dim(`session file: ${app.sessionFile}\ntrace file:   ${app.tracer.file}\nphase: ${app.session.state.phase}\nrequest: ${JSON.stringify(app.session.state.request)}`));
        return true;
      case "/bookings": {
        const bookings = await app.listBookings();
        if (!bookings.length) console.log(c.dim("no bookings"));
        for (const b of bookings) console.log(`  ${b.booking_id}  ${b.status.padEnd(22)} ${b.when.padEnd(8)} ${b.service.padEnd(13)} ${b.provider_name} — ${slotLabel(b.slot)} — ₹${b.price}`);
        return true;
      }
      case "/memory": {
        const items = app.listMemories(args[0] === "all");
        for (const m of items) {
          const tag = m.status === "forgotten" ? c.red("forgotten") : m.source === "explicit" ? c.green("explicit") : m.confirmed ? c.green("inferred✓") : c.yellow("inferred?");
          console.log(`  ${c.dim(m.id)}  ${tag.padEnd(18)} ${m.scope}.${m.key} = ${m.value || c.dim("(erased)")}`);
        }
        console.log(c.dim(`  ${items.length} item(s). Only explicit and confirmed (✓) facts are ever sent to the model.`));
        return true;
      }
      case "/forget": {
        if (!args[0]) return console.log("usage: /forget <id|key>"), true;
        const removed = app.forgetMemory(args[0]);
        console.log(removed.length ? c.green(`forgot ${removed.map((m) => `${m.scope}.${m.key}`).join(", ")}`) : c.red("no matching memory"));
        return true;
      }
      case "/confirm-memory": {
        const m = args[0] ? app.confirmMemory(args[0]) : undefined;
        console.log(m ? c.green(`confirmed ${m.scope}.${m.key}`) : c.red("usage: /confirm-memory <id>"));
        return true;
      }
      case "/edit-memory": {
        const [id, ...rest] = args;
        const m = id && rest.length ? app.editMemory(id, rest.join(" ")) : undefined;
        console.log(m ? c.green(`updated ${m.scope}.${m.key} = ${m.value}`) : c.red("usage: /edit-memory <id> <value>"));
        return true;
      }
      case "/force-book": {
        const valid = ["success", "slot_taken", "timeout_booked", "timeout_not_booked"];
        if (!args[0] || !valid.includes(args[0])) return console.log(`usage: /force-book ${valid.join("|")}`), true;
        app.forceNextBookOutcome(args[0] as ForcedBookOutcome);
        console.log(c.dim(`next book() call will return: ${args[0]}`));
        return true;
      }
      case "/price-change": {
        const pct = Number(args[1]);
        if (!args[0] || Number.isNaN(pct)) return console.log("usage: /price-change <provider_id> <pct e.g. 0.15>"), true;
        app.setPriceChange(args[0].toUpperCase(), pct);
        console.log(c.dim(`hold price change for ${args[0].toUpperCase()}: ${pct}`));
        return true;
      }
      case "/provider-cancel": {
        if (!args[0]) return console.log("usage: /provider-cancel <booking_id>"), true;
        const ev = app.simulateProviderCancel(args[0]);
        console.log(c.dim(`provider cancelled ${ev.booking_id} (event ${ev.id}). The agent will notice on its next poll…`));
        return true;
      }
      default:
        if (line.startsWith("/")) {
          console.log(c.red(`unknown command ${cmd}. Try /help`));
          return true;
        }
        return false;
    }
  }

  const processQueue = async () => {
    if (busy) return;
    const line = queue.shift();
    if (line === undefined) return;
    await withBusy(async () => {
      if (!(await handleCommand(line))) {
        const out = await app.handleUserMessage(line, hooks);
        render(out);
      }
    });
    if (queue.length) return processQueue();
    rl.prompt();
  };

  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return rl.prompt();
    queue.push(line);
    void processQueue();
  });

  rl.on("close", () => {
    clearInterval(poller);
    console.log(c.dim("\nbye — session saved."));
    process.exit(0);
  });

  // Proactive follow-up: poll provider events without waiting for user input.
  const poller = setInterval(() => {
    if (busy || queue.length) return;
    void withBusy(async () => {
      if ((await checkEvents()) && !queue.length) rl.prompt();
    }).then(processQueue);
  }, 3000);

  rl.prompt();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
