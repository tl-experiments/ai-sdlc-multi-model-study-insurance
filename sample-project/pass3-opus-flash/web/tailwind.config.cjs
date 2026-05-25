/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Pass 3: Opus + Gemini Flash brand palette (cyan)
        brand: {"50":"#ecfeff","100":"#cffafe","500":"#06b6d4","600":"#0891b2","700":"#0e7490","800":"#155e75"},
      },
    },
  },
  plugins: [],
};
