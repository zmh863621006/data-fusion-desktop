import { load } from 'cheerio';
import { AppError } from '../../core/errors/app-error';
import { ONE_WINDOW_ORIGIN } from './catalog';
import type { OneWindowField, OneWindowHtmlData } from './types';

export const oneWindowText = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
export const oneWindowObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export const oneWindowFailure = (message: string) => new AppError('REMOTE_REQUEST_FAILED', message, { retryable: false });

const credentialKey = /(?:access.?token|refresh.?token|authorization|cookie|password|plainpass|csrf|session(?:id)?|checkcode|^pwd$|^token$|^signature$)/i;

/** Source business data can contain links. Authentication parameters never leave the source client. */
export function sanitizeOneWindowData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOneWindowData);
  if (oneWindowObject(value)) return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !credentialKey.test(key)).map(([key, entry]) => [key, sanitizeOneWindowData(entry)]));
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (/^[{[]/.test(trimmed)) {
    try { return JSON.stringify(sanitizeOneWindowData(JSON.parse(trimmed))); } catch { /* Preserve source text that is not JSON. */ }
  }
  if (/^(?:https?:\/\/|\/)/i.test(trimmed)) {
    try {
      const url = new URL(trimmed, ONE_WINDOW_ORIGIN);
      for (const name of [...url.searchParams.keys()]) if (credentialKey.test(name)) url.searchParams.delete(name);
      return /^https?:\/\//i.test(trimmed) ? url.href : url.pathname + url.search + url.hash;
    } catch { /* Ordinary textual fields remain ordinary text. */ }
  }
  return value;
}

function cleanText(value: string): string { return value.replace(/\u00a0/g, ' ').replace(/[ \t\r\n]+/g, ' ').trim(); }

export function parseOneWindowHtml(html: string): OneWindowHtmlData {
  const $ = load(html);
  $('script,style,noscript,iframe,object,embed,button').remove();
  $('input[type="password"],input[type="hidden"]').remove();
  const fields: OneWindowHtmlData['fields'] = [];
  $('th').each((_index, node) => {
    const label = cleanText($(node).text()).replace(/[：:]$/, '');
    const cell = $(node).next('td');
    if (!label || !cell.length) return;
    const key = cell.find('input').first().attr('id') || label;
    const values = cell.find('input:not([type="checkbox"]):not([type="radio"]),textarea,select').map((_i, field) =>
      $(field).is('select') ? $(field).find('option:selected').text() : oneWindowText($(field).val())).get();
    cell.find('input').remove();
    fields.push({ key, label, value: cleanText([cell.text(), ...values].filter(Boolean).join(' ')) });
  });
  const tables: string[][][] = [];
  $('table').each((_index, node) => {
    const rows: string[][] = [];
    $(node).find('tr').filter((_i, row) => $(row).closest('table')[0] === node).each((_i, row) => {
      rows.push($(row).children('th,td').map((_j, cell) => cleanText($(cell).clone().find('table').remove().end().text())).get());
    });
    if (rows.length) tables.push(rows);
  });
  const text = cleanText($('body').text());
  return { fields, tables, text };
}

/** Only literal URLs from the authenticated detail document are parsed, never JavaScript expressions. */
export function oneWindowDetailLinks(html: string): Map<string, URL> {
  const links = new Map<string, URL>();
  for (const match of html.matchAll(/\.load\(\s*(['"])([^'"\r\n]+)\1\s*\)/g)) {
    let url: URL;
    try { url = new URL(match[2], ONE_WINDOW_ORIGIN); } catch { continue; }
    if (url.origin !== ONE_WINDOW_ORIGIN || !url.pathname.startsWith('/Accept/accept/')) continue;
    const name = url.pathname.split('/').pop()!;
    const previous = links.get(name);
    // A second lazy-loaded businessBase link can omit busNum. Prefer the initial complete one.
    if (!previous || [...url.searchParams].length > [...previous.searchParams].length) links.set(name, url);
  }
  return links;
}

export function oneWindowLiteral(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('\\b(?:var|let|const)\\s+' + escaped + '\\s*=\\s*(["\'])([^"\'\\r\\n]*)\\1\\s*;').exec(html)?.[2] ?? '';
}

export function parseOneWindowFormFields(value: unknown): OneWindowField[] {
  let content = value;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { throw oneWindowFailure('一窗电子表单字段定义格式异常'); }
  }
  const fields = new Map<string, OneWindowField>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (oneWindowObject(node)) {
      const key = oneWindowText(node.keyCode ?? node.key);
      const label = oneWindowText(node.title);
      if (key && label && !credentialKey.test(key)) {
        const source = oneWindowObject(node.optionVal) && Array.isArray(node.optionVal.data) ? node.optionVal.data : [];
        const options = source.filter(oneWindowObject).map(option => ({
          value: oneWindowText(option.value), label: oneWindowText(option.label),
        })).filter(option => option.value && option.label);
        fields.set(key, { key, label, ...(options.length ? { options } : {}) });
      }
    }
    for (const item of Object.values(node)) if (item && typeof item === 'object') visit(item);
  };
  visit(content);
  return [...fields.values()];
}

export function oneWindowDisplayData(data: Record<string, unknown>, fields: OneWindowField[]): Record<string, unknown> {
  const choices = new Map(fields.filter(field => field.options?.length).map(field => [field.key,
    new Map(field.options!.map(option => [option.value, option.label]))]));
  const decode = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map(item => decode(item, key));
    if (oneWindowObject(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, decode(item, name)]));
    if (typeof value === 'string' && choices.has(key)) return choices.get(key)!.get(value) ?? value;
    return value;
  };
  return decode(data) as Record<string, unknown>;
}

export function parseOneWindowJson(text: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw oneWindowFailure('一窗接口未返回有效的业务数据'); }
  if (!oneWindowObject(parsed)) throw oneWindowFailure('一窗业务响应结构异常');
  const message = oneWindowText(parsed.error ?? parsed.message ?? parsed.msg);
  if ([401, '401'].includes(parsed.code as string | number) || /(?:未登录|请.{0,6}登录|会话.{0,6}(?:失效|过期)|session\s+(?:expired|invalid))/i.test(message)) {
    throw new AppError('SESSION_EXPIRED', '一窗平台会话已失效，请在原系统重新登录');
  }
  if (parsed.error || parsed.success === false) throw oneWindowFailure('一窗系统拒绝本次业务读取，请在原系统核对权限');
  return parsed;
}
