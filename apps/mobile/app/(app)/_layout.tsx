import { Stack } from 'expo-router';

/** Écrans accessibles une fois la session établie. */
export default function AppLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
