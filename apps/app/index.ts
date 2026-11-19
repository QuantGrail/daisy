import React from "react";
import { registerRootComponent } from "expo";
import { BootGuard } from "@daisy-ai/ui";
import App from "./App";
// P6-27 (P5N-7): an error while drawing shows a message and a reload
// button — never an empty page under the title.
function Root() {
  return React.createElement(BootGuard, null, React.createElement(App));
}
registerRootComponent(Root);
