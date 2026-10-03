import './globals.css';

export const metadata = {
  title: '分會管理平台',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-TW">
      <body>{children}</body>
    </html>
  );
}
