import assert from "node:assert/strict";
import { test } from "node:test";
import { fizzbuzz } from "../src/fizzbuzz.js";

test("multiples of 3 are Fizz", () => {
  assert.equal(fizzbuzz(9), "Fizz");
});

test("multiples of 5 are Buzz", () => {
  assert.equal(fizzbuzz(10), "Buzz");
});

test("multiples of 3 and 5 are FizzBuzz", () => {
  assert.equal(fizzbuzz(30), "FizzBuzz");
});

test("other numbers are returned as text", () => {
  assert.equal(fizzbuzz(7), "7");
});
