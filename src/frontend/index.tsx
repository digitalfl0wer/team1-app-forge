import React, { useState, useEffect } from "react";
import ForgeReconciler, { Frame, Text } from "@forge/react";
import { invoke } from '@forge/bridge';

const App = () => {
  const [data, setData] = useState<string | null>(null);

  useEffect(() => {
    invoke('getText', { example: 'my-invoke-variable' }).then((response) => {
      setData(response as unknown as string);
    });
  }, []);

  return (
    <>
      <Text>{data ?? 'Loading...'}</Text>
      <Frame resource="frame" height="100%" />
    </>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
