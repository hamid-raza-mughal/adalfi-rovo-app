import "./globals.css";

export const metadata = {
  title: "AdalFi Orchestrator",
  description: "Chat shell that triggers a Rovo flow and shows the reply",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
