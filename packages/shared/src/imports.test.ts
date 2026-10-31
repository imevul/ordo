import { describe, expect, it } from 'vitest';
import { detectCsvColumns, guessStateType, parseCsv, parsePriority, toCsv } from './imports.ts';

describe('parseCsv', () => {
  it('reads quoted fields, doubled quotes and line breaks inside quotes', () => {
    const csv = 'Title,Description\r\n"Fix, then ship","Line one\nsays ""hi"""\r\nPlain,\r\n';
    expect(parseCsv(csv)).toEqual([
      ['Title', 'Description'],
      ['Fix, then ship', 'Line one\nsays "hi"'],
      ['Plain', ''],
    ]);
  });

  it('guesses semicolons and tabs, strips a BOM and skips empty lines', () => {
    expect(parseCsv('﻿a;b\n\n1;2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a\tb\n1\t2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps a last line without a newline, and empty trailing fields', () => {
    expect(parseCsv('a,b,c\n1,,')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ]);
  });
});

describe('detectCsvColumns', () => {
  it('maps the headers Linear and Jira export', () => {
    const linear = detectCsvColumns(['ID', 'Team', 'Title', 'Status', 'Assignee', 'Labels']);
    expect(linear).toMatchObject({ id: 'ID', team: 'Team', title: 'Title', status: 'Status' });
    const jira = detectCsvColumns(['Issue key', 'Summary', 'Reporter', 'Story Points', 'Resolved']);
    expect(jira).toMatchObject({
      id: 'Issue key',
      title: 'Summary',
      creator: 'Reporter',
      estimate: 'Story Points',
      completedAt: 'Resolved',
      description: null,
    });
  });
});

describe('guessStateType', () => {
  it('recognises common status names', () => {
    expect(guessStateType('In Review')).toBe('started');
    expect(guessStateType('To Do')).toBe('unstarted');
    expect(guessStateType("Won't fix")).toBe('canceled');
    expect(guessStateType('Done')).toBe('completed');
    expect(guessStateType('Icebox')).toBe('backlog');
    expect(guessStateType('Waiting on vendor')).toBeNull();
  });
});

describe('parsePriority', () => {
  it('takes numbers and words', () => {
    expect(parsePriority('2')).toBe(2);
    expect(parsePriority('Highest')).toBe(1);
    expect(parsePriority('Medium')).toBe(3);
    expect(parsePriority('')).toBe(0);
    expect(parsePriority('whenever')).toBeNull();
  });
});

describe('toCsv', () => {
  it('quotes what needs quoting and reads back the same', () => {
    const rows = [
      ['ID', 'Title'],
      ['ENG-1', 'Say "hi", then\nleave'],
      ['ENG-2', null],
    ];
    const csv = toCsv(rows);
    expect(csv.startsWith('\ufeffID,Title\r\n')).toBe(true);
    expect(parseCsv(csv)).toEqual([
      ['ID', 'Title'],
      ['ENG-1', 'Say "hi", then\nleave'],
      ['ENG-2', ''],
    ]);
  });

  it('keeps typed text from running as a formula when asked', () => {
    const row = ['=HYPERLINK("http://x")', '+1', '-2', '@SUM(A1)', 'a=b', -3];
    expect(parseCsv(toCsv([row], { formulaSafe: true }))).toEqual([
      ['\'=HYPERLINK("http://x")', "'+1", "'-2", "'@SUM(A1)", 'a=b', '-3'],
    ]);
  });

  it('leaves leading - and = alone by default, so exports import back as they are', () => {
    const row = ['- [ ] step one', '=x', '@alice'];
    expect(parseCsv(toCsv([row]))).toEqual([row]);
  });
});
