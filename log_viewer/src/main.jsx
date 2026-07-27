import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <main className="fatal-error" role="alert">
          <span>SAFE MODE</span>
          <h1>表示を安全に停止しました</h1>
          <p>予期しない入力で画面処理を継続できませんでした。ページを再読み込みし、診断対象を小さく分けてください。</p>
          <button onClick={() => location.reload()}>再読み込み</button>
        </main>
      );
    }
    return this.props.children;
  }
}

const container = document.getElementById("root");
createRoot(container).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>
);
