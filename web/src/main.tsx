import { createRoot } from "react-dom/client";
import { EuiProvider } from "@elastic/eui";
import { EuiThemeBorealis } from "@elastic/eui-theme-borealis";
import App from "./App";
import "./icons";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <EuiProvider theme={EuiThemeBorealis} colorMode="dark">
    <App />
  </EuiProvider>,
);
