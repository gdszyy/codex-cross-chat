#!/usr/bin/env node
/**
 * Mock Codex app-server (stdio JSON-RPC 2.0 test double).
 *
 * Implements the subset of the App Server protocol the bridge needs, pinned to
 * the shape measured in evidence/m1 (v0.149.0, legacy history mode):
 *   initialize / initialized
 *   thread/start, thread/resume, thread/read{includeTurns}, thread/list
 *   turn/start, turn/interrupt
 *   notifications: thread/started, turn/started, item/completed, turn/completed
 *
 * Fault injection (for the M2 recovery matrix, §5.3 / §8.2):
 *   per-turn directive in the input text:  [[fault:delay|crash|duplicate|no_terminal]]
 *   or a process-wide default via env  MOCK_FAULT
 *   delay length via env MOCK_DELAY_MS (default 50)
 *
 * Everything is in-memory: no ~/.codex writes, no session database.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const DEFAULT_FAULT = process.env.MOCK_FAULT || 'none';
const DELAY_MS = Number(process.env.MOCK_DELAY_MS || 50);
const STATE_FILE = process.env.MOCK_STATE_FILE || '';

const threads = new Map(); // id -> { id, model, turns: [{id,status,items:[]}] }
const turns = new Map(); // turnId -> { id, threadId, status, items }

function saveState() {
  if (!STATE_FILE) return;
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ threads: [...threads.values()], turns: [...turns.values()] }),
    );
  } catch {
    /* best effort */
  }
}

function loadState() {
  if (!STATE_FILE || !fs.existsSync(STATE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const t of data.threads ?? []) threads.set(t.id, t);
    for (const t of data.turns ?? []) turns.set(t.id, t);
  } catch {
    /* start fresh */
  }
}
loadState();

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const notify = (method, params) => out({ method, params });
const reply = (id, result) => out({ id, result });
const replyErr = (id, code, message) => out({ id, error: { code, message } });

function send(ws, obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function newThread(model) {
  const id = randomUUID();
  const t = { id, model: model || 'gpt-5.6-luna', status: 'idle', turns: [] };
  threads.set(id, t);
  return t;
}

function parseFault(text) {
  const m = /\[\[fault:([a-z_]+)\]\]/.exec(text || '');
  return m ? m[1] : DEFAULT_FAULT;
}

function completeTurn(turn, text) {
  if (turn.status !== 'inProgress') return;
  turn.status = 'completed';
  turn.items.push({ type: 'agentMessage', text });
  saveState();
  notify('item/completed', { threadId: turn.threadId, turnId: turn.id, item: { type: 'agentMessage', text } });
  notify('turn/completed', {
    threadId: turn.threadId,
    turn: { id: turn.id, status: 'completed', items: turn.items },
  });
}

function schedule(turn, text, fault) {
  if (fault === 'crash') {
    // Die after the turn/start reply has been flushed: the bridge sees an
    // accepted turn whose terminal state never arrives in this process.
    setTimeout(() => process.exit(7), 10);
    return;
  }
  if (fault === 'no_terminal') return; // never completes
  const delay = fault === 'delay' ? Math.max(DELAY_MS, 300) : DELAY_MS;
  setTimeout(() => {
    completeTurn(turn, text);
    if (fault === 'duplicate') {
      // Duplicate terminal notification (§5.2 dedupe target).
      notify('turn/completed', {
        threadId: turn.threadId,
        turn: { id: turn.id, status: 'completed', items: turn.items },
      });
    }
  }, delay);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialized') return;
  try {
    switch (method) {
      case 'initialize':
        return reply(id, {
          userAgent: 'mock-codex/0.149.0',
          codexHome: process.env.CODEX_HOME || 'MOCK',
          platformFamily: 'windows',
          platformOs: 'windows',
        });
      case 'thread/start': {
        const t = newThread(params?.model);
        saveState();
        notify('thread/started', { thread: { id: t.id } });
        return reply(id, {
          thread: {
            id: t.id,
            source: 'vscode',
            historyMode: 'legacy',
            modelProvider: 'openai',
            model: t.model,
            path: `mock://threads/${t.id}`,
          },
        });
      }
      case 'thread/resume': {
        const t = threads.get(params?.threadId);
        if (!t) return replyErr(id, -32602, 'thread not found');
        return reply(id, { thread: { id: t.id, historyMode: 'legacy', model: t.model } });
      }
      case 'thread/read': {
        const t = threads.get(params?.threadId);
        if (!t) return replyErr(id, -32602, 'thread not found');
        const includeTurns = params?.includeTurns !== false;
        return reply(id, {
          thread: {
            id: t.id,
            historyMode: 'legacy',
            model: t.model,
            turns: includeTurns ? t.turns.map((x) => ({ ...x })) : undefined,
          },
        });
      }
      case 'thread/list':
        return reply(id, {
          data: [...threads.values()].map((t) => ({ id: t.id, historyMode: 'legacy', model: t.model })),
          nextCursor: null,
        });
      case 'thread/loaded/list':
        return reply(id, { data: [] });
      case 'turn/start': {
        const t = threads.get(params?.threadId);
        if (!t) return replyErr(id, -32602, 'thread not found');
        const text = (params?.input || []).map((i) => i.text || '').join('');
        const turn = { id: randomUUID(), threadId: t.id, status: 'inProgress', items: [] };
        // Record the user message so marker-based recovery (§5.3) can find this
        // turn in thread history after a crash.
        turn.items.push({ type: 'userMessage', text });
        turns.set(turn.id, turn);
        t.turns.push(turn);
        t.status = 'running';
        saveState();
        notify('turn/started', { threadId: t.id, turn: { id: turn.id, status: 'inProgress' } });
        const fault = parseFault(text);
        const answer = `MOCK-REPLY ${text.replace(/\[\[fault:[a-z_]+\]\]/g, '').trim()}`.trim();
        reply(id, { turn: { id: turn.id, status: 'inProgress' } });
        schedule(turn, answer, fault);
        return;
      }
      case 'turn/interrupt': {
        const turn = turns.get(params?.turnId);
        if (turn && turn.status === 'inProgress') {
          turn.status = 'interrupted';
          saveState();
          notify('turn/completed', {
            threadId: turn.threadId,
            turn: { id: turn.id, status: 'interrupted', items: turn.items },
          });
        }
        return reply(id, {});
      }
      default:
        return replyErr(id, -32601, `method not found: ${method}`);
    }
  } catch (err) {
    return replyErr(id, -32603, String(err && err.message ? err.message : err));
  }
});

rl.on('close', () => process.exit(0));
