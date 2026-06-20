import { describe, expect, test } from 'vitest';
import { isPkg8Postback } from './trycle-pkg8.js';

describe('isPkg8Postback', () => {
  test('matches faq_ prefix postbacks', () => {
    expect(isPkg8Postback('faq_start')).toBe(true);
    expect(isPkg8Postback('faq_cat_整備')).toBe(true);
    expect(isPkg8Postback('faq_q_business-hours')).toBe(true);
    expect(isPkg8Postback('faq_h_xxx')).toBe(true);
    expect(isPkg8Postback('faq_u_xxx')).toBe(true);
  });

  test('matches legacy pkg8_ prefix for backward compatibility', () => {
    expect(isPkg8Postback('pkg8_start')).toBe(true);
  });

  test('rejects other prefixes', () => {
    expect(isPkg8Postback('pkg1_start')).toBe(false);
    expect(isPkg8Postback('consent_open')).toBe(false);
    expect(isPkg8Postback('reservation_create')).toBe(false);
    expect(isPkg8Postback('random_postback')).toBe(false);
    expect(isPkg8Postback('')).toBe(false);
  });

  test('handles edge cases', () => {
    expect(isPkg8Postback('faq')).toBe(false); // prefix incomplete (no trailing _)
    expect(isPkg8Postback('pkg8')).toBe(false);
    expect(isPkg8Postback('_faq_start')).toBe(false); // leading underscore
  });
});
