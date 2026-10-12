/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{html,js}'],
  theme: {
    // 전체(코드/URL 포함) 맑은 고딕
    fontFamily: {
      sans: ["Malgun Gothic", "맑은 고딕", "sans-serif"],
      mono: ["Malgun Gothic", "맑은 고딕", "sans-serif"],
    },
    extend: {
      // 기본보다 한 단계씩 크게 (가독성)
      fontSize: {
        xs: ['13px', '18px'],
        sm: ['15px', '22px'],
        base: ['17px', '26px'],
      },
    },
  },
  plugins: [],
};
