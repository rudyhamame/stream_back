import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArabicSearch, arabicSearchRegexSource } from '../arabic-search.js';

test('folds ta marbuta, hamza seats and alef variants to one form', () => {
  assert.equal(normalizeArabicSearch('الهيبة'), normalizeArabicSearch('الهيبه'));
  assert.equal(normalizeArabicSearch('أحمد'), normalizeArabicSearch('احمد'));
  assert.equal(normalizeArabicSearch('إسلام'), normalizeArabicSearch('اسلام'));
  assert.equal(normalizeArabicSearch('مصطفى'), normalizeArabicSearch('مصطفي'));
  assert.equal(normalizeArabicSearch('مسؤول'), normalizeArabicSearch('مسوول'));
});

test('strips diacritics and tatweel and Arabic-Indic digits', () => {
  assert.equal(normalizeArabicSearch('نَسَمَات'), 'نسمات');
  assert.equal(normalizeArabicSearch('الـهـيـبـة'), 'الهيبه');
  assert.equal(normalizeArabicSearch('موسم ٢'), 'موسم 2');
});

test('regex matches a differently spelled stored title', () => {
  const rx = new RegExp(arabicSearchRegexSource('الهيبة'), 'i');
  assert.ok(rx.test('مسلسل الهِيبه'));
  assert.ok(rx.test('الهيبة الجزء الثاني'));
});

test('non-Arabic queries still match literally', () => {
  const rx = new RegExp(arabicSearchRegexSource('harry potter'), 'i');
  assert.ok(rx.test('AR - Harry Potter and the Goblet of Fire (2005)'));
  assert.equal(arabicSearchRegexSource(''), '');
});
