/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        savings: "#10b981",
        opus: "#7c3aed",
        gemini: "#0ea5e9",
        ink: "#0f172a",
        // Brand palette used by .input focus rings + the "View policy →" link.
        // Indigo-leaning so it doesn't clash with any specific pass color.
        brand: {
          50: "#eef2ff", 100: "#e0e7ff", 500: "#6366f1",
          600: "#4f46e5", 700: "#4338ca", 800: "#3730a3",
        },
      },
    },
  },
  plugins: [],
};
