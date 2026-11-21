// Shortens long text by cutting out the middle. The start often holds the first error and the
// end often holds the summary (for example a test runner's pass/fail counts), so both are kept.
export const truncateMiddle = (text: string, maxChars: number): string => {
  if (text.length <= maxChars) return text;

  const headChars = Math.ceil(maxChars / 2);
  const tailChars = maxChars - headChars;
  const omitted = text.length - maxChars;
  return `${text.slice(0, headChars)}\n[... ${omitted} characters omitted ...]\n${text.slice(text.length - tailChars)}`;
};
