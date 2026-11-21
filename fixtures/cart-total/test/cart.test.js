import assert from "node:assert/strict";
import { test } from "node:test";
import { cartTotal } from "../src/cart.js";

const items = [
  { price: 10, quantity: 2 },
  { price: 5, quantity: 1 },
];

test("adds up price times quantity", () => {
  assert.equal(cartTotal(items), 25);
});

test("applies a percentage discount", () => {
  assert.equal(cartTotal(items, 10), 22.5);
});

test("a 100% discount makes the cart free", () => {
  assert.equal(cartTotal(items, 100), 0);
});
