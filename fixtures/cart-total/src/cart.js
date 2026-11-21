import { applyDiscount } from "./discount.js";

export const cartTotal = (items, discountPercent = 0) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return applyDiscount(subtotal, discountPercent);
};
