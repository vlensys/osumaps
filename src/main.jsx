import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

class AppErrorBoundary extends React.Component {
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
        <main className="mx-auto min-h-screen w-full max-w-3xl px-6 py-10 text-slate-100">
          <h1 className="text-2xl font-bold">startup error</h1>
          <p className="mt-3 text-slate-300">
            the app crashed during startup. check browser console for details.
          </p>
          <pre className="mt-4 overflow-auto rounded-lg border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-200">
            {String(this.state.error?.message || this.state.error)}
          </pre>
        </main>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>
);

