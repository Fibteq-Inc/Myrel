import { LOCALE_NAMES, LOCALES } from "@altair/i18n";
import { useI18n } from "@altair/i18n/react";
import { Check, ExternalLink } from "lucide-react-native";
import type { ReactNode } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { Button, errorMessage } from "../../components/ui";
import { useSession } from "../../lib/session";
import { colors, radius } from "../../theme";

// The app's own policies, published by Fibteq; a self-hosted server's operator sets that server's terms.
const LEGAL_SITE = "https://myrel.fibteq.io";

/** Account, language and server, like the web settings' Account page. */
export default function SettingsScreen() {
  const { t, locale, setLocale } = useI18n();
  const { user, server, info, signOut, deleteAccount } = useSession();

  function confirmSignOut() {
    Alert.alert(t("mobile.signOutConfirm", { email: user?.email ?? "" }), undefined, [
      { text: t("mobile.cancel"), style: "cancel" },
      { text: t("rail.signOut"), style: "destructive", onPress: () => void signOut() },
    ]);
  }

  function confirmDelete() {
    Alert.alert(t("deleteAccount.confirmTitle"), t("deleteAccount.confirmBody", { email: user?.email ?? "" }), [
      { text: t("mobile.cancel"), style: "cancel" },
      {
        text: t("deleteAccount.confirm"),
        style: "destructive",
        onPress: () =>
          void deleteAccount().catch((err: unknown) => Alert.alert(errorMessage(err, t("common.error")))),
      },
    ]);
  }

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Section title={t("settings.profile")}>
        <Text style={styles.value}>{user?.name}</Text>
        <Text style={styles.hint}>{t("settings.signedInAs", { email: user?.email ?? "" })}</Text>
      </Section>

      <Section title={t("settings.language")} hint={t("settings.languageHint")}>
        {LOCALES.map((l) => (
          <Pressable
            key={l}
            accessibilityRole="radio"
            accessibilityState={{ selected: l === locale }}
            onPress={() => setLocale(l)}
            style={styles.option}
          >
            <Text style={styles.value}>{LOCALE_NAMES[l]}</Text>
            {l === locale && <Check size={18} color={colors.accent} />}
          </Pressable>
        ))}
      </Section>

      <Section title={t("settings.server")}>
        <Text style={styles.value}>{info?.name ?? ""}</Text>
        <Text style={styles.hint}>{t("server.current", { host: server.replace(/^https?:\/\//, "") })}</Text>
      </Section>

      <Section title={t("settings.legal")}>
        <LegalLink label={t("legal.privacy")} url={`${LEGAL_SITE}/privacy/`} />
        <LegalLink label={t("legal.terms")} url={`${LEGAL_SITE}/terms/`} />
      </Section>

      <Button variant="ghost" onPress={confirmSignOut}>
        {t("rail.signOut")}
      </Button>

      <Section title={t("deleteAccount.title")} hint={t("deleteAccount.description")}>
        <Pressable onPress={confirmDelete} accessibilityRole="button" style={styles.option}>
          <Text style={[styles.value, { color: colors.bad }]}>{t("deleteAccount.button")}</Text>
        </Pressable>
      </Section>
    </ScrollView>
  );
}

function LegalLink({ label, url }: { label: string; url: string }) {
  return (
    <Pressable onPress={() => void WebBrowser.openBrowserAsync(url)} accessibilityRole="link" style={styles.option}>
      <Text style={styles.value}>{label}</Text>
      <ExternalLink size={16} color={colors.subtle} />
    </Pressable>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text style={styles.section}>{title}</Text>
      <View style={styles.card}>{children}</View>
      {hint && <Text style={styles.hint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 24 },
  section: { color: colors.subtle, fontSize: 13, fontWeight: "600" },
  card: {
    gap: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.raised,
    padding: 14,
  },
  option: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 8 },
  value: { color: colors.fg, fontSize: 15 },
  hint: { color: colors.subtle, fontSize: 13, lineHeight: 18 },
});
