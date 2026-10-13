import ForgeReconciler, { Frame } from '@forge/react';

// Jira renders this UI Kit wrapper. Frame hosts the separately built React/Vite
// frontend, where bridge.invoke connects the Todo UI to the Forge SQL resolvers.
ForgeReconciler.render(<Frame resource="frame"/>);
