import { Stack } from 'expo-router';

/** Onboarding et authentification, avant l'établissement de la session. */
export default function AuthLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
