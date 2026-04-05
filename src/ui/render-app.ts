import { render } from "ink";
import React from "react";
import { App, type AppProps } from "./App.js";

export const INK_RENDER_OPTIONS = {
  exitOnCtrlC: false,
} as const;

export function renderApp(props: AppProps) {
  return render(React.createElement(App, props), INK_RENDER_OPTIONS);
}
