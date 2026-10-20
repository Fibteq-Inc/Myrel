import { LOCALE_NAMES, LOCALES } from "@myrel/i18n";
import { useI18n, useT } from "@myrel/i18n/react";
import * as WebBrowser from "expo-web-browser";
import { Check } from "lucide-react-native";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { MyrelMark, Button, errorMessage, Input } from "../components/ui";
import { useSession } from "../lib/session";
import { colors } from "../theme";

export default function LoginScreen() {
  const t = useT();
  const session = useSession();
  const [editingServer, setEditingServer] = useState(session.server === "");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ground }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
          <View style={styles.brand}>
            <MyrelMark size={44} />
            <Text style={styles.brandName}>Myrel</Text>
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
                  {session.info?.name ?? t("settings.server")} · {hostOf(session.server)}
                </Text>
                <Text style={styles.link}>{t("server.change")}</Text>
              </Pressable>
            </>
          )}
          <LanguageSwitch />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** Language choice before signing in, as on the web sign-in page. */
export function LanguageSwitch() {
  const { locale, setLocale } = useI18n();
  return (
    <View style={styles.languages} accessibilityRole="radiogroup">
      {LOCALES.map((l) => (
        <Pressable
          key={l}
          accessibilityRole="radio"
          accessibilityState={{ selected: l === locale }}
          onPress={() => setLocale(l)}
          hitSlop={8}
        >
          <Text style={[styles.language, l === locale && { color: colors.fg }]}>{LOCALE_NAMES[l]}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function hostOf(origin: string) {
  return origin.replace(/^https?:\/\//, "");
}

/** Lets the user point the app at any Myrel server, e.g. a self-hosted one. */
function ServerForm({ onDone }: { onDone: () => void }) {
  const t = useT();
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
      setError(errorMessage(err, t("common.error")));
    } finally {
      setPending(false);
    }
  }

  return (
    <View style={styles.form}>
      <Text style={styles.title}>{t("mobile.serverTitle")}</Text>
      <Text style={styles.hint}>{t("mobile.serverHint")}</Text>
      <Input
        value={value}
        onChangeText={setValue}
        placeholder="myrel.example.com"
        keyboardType="url"
        textContentType="URL"
        returnKeyType="go"
        onSubmitEditing={submit}
        accessibilityLabel={t("server.label")}
      />
      {error && <Text style={styles.error}>{error}</Text>}
      <Button onPress={submit} pending={pending} disabled={!value.trim()}>
        {t("server.connect")}
      </Button>
      {session.server !== "" && (
        <Button variant="ghost" onPress={onDone}>
          {t("mobile.cancel")}
        </Button>
      )}
    </View>
  );
}

function SignInForm() {
  const t = useT();
  const session = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const signUpAllowed = session.info?.auth.signUp !== false;
  const legal = mode === "signup" ? session.info?.legal : null;

  async function submit() {
    setPending(true);
    setError(null);
    try {
      if (mode === "signup") await session.signUp({ email, password, name, acceptTerms: accepted });
      else await session.signIn({ email, password });
    } catch (err) {
      setError(errorMessage(err, t("common.error")));
      setPending(false);
    }
  }

  return (
    <View style={styles.form}>
      <Text style={styles.title}>{mode === "signin" ? t("login.signInTitle") : t("login.signUpTitle")}</Text>
      {mode === "signup" && (
        <Input value={name} onChangeText={setName} placeholder={t("login.name")} autoCapitalize="words" textContentType="name" />
      )}
      <Input
        value={email}
        onChangeText={setEmail}
        placeholder={t("login.email")}
        keyboardType="email-address"
        textContentType="emailAddress"
        autoComplete="email"
      />
      <Input
        value={password}
        onChangeText={setPassword}
        placeholder={t("login.password")}
        secureTextEntry
        textContentType={mode === "signin" ? "password" : "newPassword"}
        autoComplete={mode === "signin" ? "current-password" : "new-password"}
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      {legal && (
        <View style={styles.accept}>
          <Pressable
            onPress={() => setAccepted(!accepted)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: accepted }}
            hitSlop={10}
            style={[styles.box, accepted && styles.boxOn]}
          >
            {accepted && <Check size={14} color={colors.ground} strokeWidth={3} />}
          </Pressable>
          <Text style={[styles.hint, { flex: 1 }]}>
            {t("login.accept.before")}
            <Text style={styles.termsLink} onPress={() => void WebBrowser.openBrowserAsync(legal.terms)}>
              {t("legal.terms")}
            </Text>
            {t("login.accept.and")}
            <Text style={styles.termsLink} onPress={() => void WebBrowser.openBrowserAsync(legal.privacy)}>
              {t("legal.privacy")}
            </Text>
            {t("login.accept.after")}
          </Text>
        </View>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <Button onPress={submit} pending={pending} disabled={!email || password.length < 8 || (legal != null && !accepted)}>
        {mode === "signin" ? t("login.signIn") : t("login.signUp")}
      </Button>
      {signUpAllowed ? (
        <Pressable onPress={() => setMode(mode === "signin" ? "signup" : "signin")} accessibilityRole="button">
          <Text style={[styles.hint, { textAlign: "center" }]}>
            {mode === "signin" ? t("login.toSignUp") : t("login.toSignIn")}
          </Text>
        </Pressable>
      ) : (
        <Text style={[styles.hint, { textAlign: "center" }]}>{t("login.signUpClosed")}</Text>
      )}
    </View>
  );
}

function Offline() {
  const t = useT();
  const session = useSession();
  return (
    <View style={styles.form}>
      <Text style={styles.title}>{t("mobile.offlineTitle", { host: hostOf(session.server) })}</Text>
      <Text style={styles.hint}>{t("mobile.offlineBody")}</Text>
      <Button onPress={session.retry}>{t("mobile.retry")}</Button>
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
  accept: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  box: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: colors.edge,
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  termsLink: { color: colors.link, textDecorationLine: "underline" },
  serverRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  serverText: { flex: 1, color: colors.subtle, fontSize: 13 },
  link: { color: colors.link, fontSize: 13 },
  languages: { flexDirection: "row", justifyContent: "center", gap: 20 },
  language: { color: colors.subtle, fontSize: 13 },
});
