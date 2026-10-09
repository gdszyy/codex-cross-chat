/**
 * Human diagnostic face (§6): three-layer CSV export with UTF-8 BOM so Excel
 * opens Chinese text correctly on double-click.
 */
import type { Store } from './domain.js';

const BOM = '\uFEFF';

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(cell).join(',')];
  for (const r of rows) lines.push(r.map(cell).join(','));
  return BOM + lines.join('\r\n') + '\r\n';
}

export type ExportLayer = 'roster' | 'messages' | 'states';

export async function exportCsv(
  store: Store,
  layer: ExportLayer,
  filter: { from?: number; to?: number; project?: string },
): Promise<string> {
  if (layer === 'roster') {
    const rows = await store.listRoster({ project: filter.project });
    return toCsv(
      [
        'conv_id', 'alias', 'role', 'task', 'task_ref', 'project', 'owner_label', 'tier',
        'device', 'profile', 'threadId', 'delivery_mode', 'allow_sources', 'roster_status',
        'registered_via', 'registered_at', 'last_seen_at', 'last_pull_at',
      ],
      rows.map((r) => [
        r.conv_id, r.alias, r.role, r.task, r.task_ref, r.project, r.owner_label, r.tier,
        r.device_id, r.profile, r.thread_id, r.delivery_mode, r.allow_sources.join('|'),
        r.roster_status, r.registered_via, new Date(r.registered_at).toISOString(),
        r.last_seen_at ? new Date(r.last_seen_at).toISOString() : '',
        r.last_pull_at ? new Date(r.last_pull_at).toISOString() : '',
      ]),
    );
  }

  if (layer === 'messages') {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.from !== undefined) {
      params.push(filter.from);
      clauses.push(`created_at >= $${params.length}`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      clauses.push(`created_at <= $${params.length}`);
    }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    const rows = await store.db.query(
      `SELECT * FROM requests${where} ORDER BY created_at ASC`,
      params,
    );
    return toCsv(
      [
        'request_id', 'root_request_id', 'chain_depth', 'from_conv', 'to_conv', 'type',
        'delivery_status', 'exec_status', 'return_status', 'body_excerpt', 'size_bytes',
        'created_at', 'delivered_at', 'returned_at',
      ],
      rows.map((r: any) => [
        r.request_id, r.root_request_id, Number(r.chain_depth), r.from_conv, r.to_conv, r.type,
        r.delivery_status, r.exec_status, r.return_status ?? '',
        String(r.body).slice(0, 200), Number(r.size_bytes),
        new Date(Number(r.created_at)).toISOString(),
        r.delivered_at ? new Date(Number(r.delivered_at)).toISOString() : '',
        r.returned_at ? new Date(Number(r.returned_at)).toISOString() : '',
      ]),
    );
  }

  // states layer
  const ov = await store.overview();
  const rows: unknown[][] = [];
  for (const d of ov.devices) {
    rows.push(['device', d.device_id, d.online ? 'online' : 'offline', d.revoked ? 'revoked' : 'active', d.last_seen_at ?? '', '']);
  }
  for (const b of ov.backlog_by_conv) {
    rows.push(['backlog', b.conv_id, b.n, '', '', '']);
  }
  for (const r of ov.waiting_user) rows.push(['waiting_user', r, '', '', '', '']);
  for (const r of ov.results_pending) rows.push(['results_pending', r, '', '', '', '']);
  for (const r of ov.failed) rows.push(['failed', r, '', '', '', '']);
  rows.push(['chain_limited', '', ov.chain_limited, '', '', '']);
  return toCsv(['category', 'ref', 'value', 'state', 'last_seen_at', 'note'], rows);
}
