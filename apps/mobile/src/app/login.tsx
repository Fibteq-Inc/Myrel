import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AltairMark, Button, errorMessage, Input } from "../components/ui";
import { useSession } from "../lib/session";
import { colors } from "../theme";

export default function LoginScreen() {
  const session = useSession();
  const [editingServer, setEditingServer] = useState(session.server === "");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <AltairMark size={44} />
            <Text style={styles.brandName}>Altair</Text>
          </View>
          {session.offline && !editingServer ? (
            <Offline />
          ) : editingServer ? (
            <ServerForm onDone={() => setEditingServer(false)} />
          ) : (
            <>
              <SignInForm />
              <Pressable onPress={() => setEditingServer(true)} style={styles.serverRow} accessibilityRole="button">
                <Text style={styles.serverText} numberOfLines={1}>
                  {session.info?.name ?? "Server"} · {hostOf(session.server)}
                </Text>
                <Text style={styles.link}>Change</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function hostOf(origin: string) {
  return origin.replace(/^https?:\/\//, "");
}

/** Lets the user point the app at any Altair server, e.g. a self-hosted one. */
function ServerForm({ onDone }: { onDone: () => void }) {
  const session = useSession();
  const [value, setValue] = useState(session.server ? hostOf(session.server) : "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit() {
    setPending(true);
    setError(null);
    try {
      await session.chooseServer(value);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.form}>
      <Text style={styles.title}>Connect to a server</Text>
      <Text style={styles.hint}>Enter the address of your Altair server, hosted or self-hosted.</Text>
      <Input
        value={value}
        onChangeText={setValue}
        placeholder="altair.example.com"
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        onSubmitEditing={submit}
        accessibilityLabel="Server address"
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button onPress={submit} pending={pending} disabled={!value.trim()}>
        Connect
      </Button>
      {session.server !== "" && (
        <Button variant="ghost" onPress={onDone}>
          Cancel
        </Button>
      )}
    </View>
  );
}

function SignInForm() {
  const session = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signUpAllowed = session.info?.auth.signUp !== false;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      if (mode === "signup") await session.signUp({ email, password, name });
      else await session.signIn({ email, password });
    } catch (err) {
      setError(errorMessage(err));
      setPending(false);
    }
  }

  return (
    <View style={styles.form}>
      <Text style={styles.title}>{mode === "signin" ? "Sign in to Altair" : "Create an account"}</Text>
      {mode === "signup" && (
        <Input value={name} onChangeText={setName} placeholder="Name" autoCapitalize="words" textContentType="name" />
      )}
      <Input
        value={email}
        onChangeText={setEmail}
        placeholder="Email"
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
      />
      <Input
        value={password}
        onChangeText={setPassword}
        placeholder="Password"
        secureTextEntry
        textContentType={mode === "signin" ? "password" : "newPassword"}
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button onPress={submit} pending={pending} disabled={!email || password.length < 8}>
        {mode === "signin" ? "Sign in" : "Sign up"}
      </Button>
      {signUpAllowed ? (
        <Pressable onPress={() => setMode(mode === "signin" ? "signup" : "signin")} accessibilityRole="button">
          <Text style={[styles.hint, { textAlign: "center" }]}>
            {mode === "signin" ? "No account? Sign up" : "Have an account? Sign in"}
          </Text>
        </Pressable>
      ) : (
        <Text style={[styles.hint, { textAlign: "center" }]}>New sign-ups are closed on this server.</Text>
      )}
    </View>
  );
}

function Offline() {
  const session = useSession();
  return (
    <View style={styles.form}>
      <Text style={styles.title}>Can't reach {hostOf(session.server)}</Text>
      <Text style={styles.hint}>Check your connection and try again.</Text>
      <Button onPress={session.retry}>Try again</Button>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flexGrow: 1, justifyContent: "center", padding: 24, gap: 28 },
  brand: { alignItems: "center", gap: 12 },
  brandName: { color: colors.fg, fontSize: 22, fontWeight: "600" },
  form: { gap: 12 },
  title: { color: colors.fg, fontSize: 22, fontWeight: "600" },
  hint: { color: colors.subtle, fontSize: 14, lineHeight: 20 },
  error: { color: colors.bad, fontSize: 14 },
  serverRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  serverText: { flex: 1, color: colors.subtle, fontSize: 13 },
  link: { color: colors.link, fontSize: 13 },
});
