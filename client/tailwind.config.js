/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // CEX 風格深色主題
        bg: {
          primary: '#0B0E11',
          secondary: '#161A1E',
          tertiary: '#1E2329',
          hover: '#2B3139',
        },
        text: {
          primary: '#EAECEF',
          secondary: '#848E9C',
          tertiary: '#5E6673',
        },
        trade: {
          buy: '#0ECB81',
          sell: '#F6465D',
          buyHover: '#0DB872',
          sellHover: '#E63854',
        },
        primary: {
          DEFAULT: '#FCD535',
          hover: '#F0C419',
        },
        info: '#3772FF',
        border: {
          DEFAULT: '#2B3139',
          hover: '#474D57',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'sans-serif'],
        mono: ['SF Mono', 'Consolas', 'Monaco', 'monospace'],
      },
      fontSize: {
        'xs': '11px',
        'sm': '12px',
        'base': '14px',
        'lg': '16px',
        'xl': '20px',
      },
    },
  },
  plugins: [],
}

