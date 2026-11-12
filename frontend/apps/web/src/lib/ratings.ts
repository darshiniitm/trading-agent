// Technical-rating label bands (plan §3). Ratings are OUR computation of the TradingView method.
export type RatingLabel = "Strong sell" | "Sell" | "Neutral" | "Buy" | "Strong buy";

export function ratingLabel(r: number | null | undefined): RatingLabel | null {
  if (r === null || r === undefined || !Number.isFinite(r)) return null;
  if (r < -0.5) return "Strong sell";
  if (r < -0.1) return "Sell";
  if (r <= 0.1) return "Neutral";
  if (r <= 0.5) return "Buy";
  return "Strong buy";
}

// Chevron glyphs so a rating is never conveyed by colour alone.
export const RATING_ICON: Record<RatingLabel, string> = { "Strong buy": "⌃⌃", Buy: "⌃", Neutral: "—", Sell: "⌄", "Strong sell": "⌄⌄" };
