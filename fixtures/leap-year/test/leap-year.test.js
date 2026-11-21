import assert from "node:assert/strict";
import { test } from "node:test";
import { isLeapYear } from "../src/leap-year.js";

test("years divisible by 4 are leap years", () => {
  assert.equal(isLeapYear(2024), true);
});

test("other years are not leap years", () => {
  assert.equal(isLeapYear(2023), false);
});

test("century years are not leap years", () => {
  assert.equal(isLeapYear(1900), false);
});

test("every 400th year is a leap year", () => {
  assert.equal(isLeapYear(2000), true);
});
