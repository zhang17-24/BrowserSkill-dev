import { i18n } from "@browser-skill/i18n";
import { I18nextProvider } from "@browser-skill/i18n/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { MockApp } from "./App";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("Mock rules root is missing");
ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <I18nextProvider i18n={i18n}>
      <MockApp />
    </I18nextProvider>
  </React.StrictMode>,
);
