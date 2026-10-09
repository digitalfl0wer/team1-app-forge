import React, { useEffect } from "react";
import { view } from "@forge/bridge";
import { Text } from "@atlaskit/primitives";

const App: React.FC = () => {
  useEffect(() => {
    view.theme.enable();
  }, []);

  return (
    <div>
      <h1>GridIron Survivor</h1>
      <h2>Team 1</h2>
      <h3>Testing deployment</h3>
    </div>
  );
};

export default App;
