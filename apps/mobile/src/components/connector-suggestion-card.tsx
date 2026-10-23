import { ApiError } from "@myrel/client";
import { useT } from "@myrel/i18n/react";
import type { ConnectorOffer, ConnectorSuggestion } from "@myrel/protocol";
import { useMutation } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { CircleCheck, CircleSlash, Plug } from "lucide-react-native";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { platform } from "../lib/platform";
import { useApi } from "../lib/session";
import { makeStyles, radius, useColors } from "../theme";
import { Button, errorMessage, Input } from "./ui";

/**
 * The thread agent's offer of a connector it needs (see the web's card). One tap connects it as
 * the person's own connector, on in this project; a service that signs in opens in the browser,
 * and the card updates here once the sign-in is done.
 */
export function ConnectorSuggestionCard({
  suggestion,
  projectId,
  threadId,
}: {
  suggestion: ConnectorSuggestion;
  projectId: string;
  threadId: string;
}) {
  const t = useT();
  const api = useApi();
  const colors = useColors();
  const styles = useStyles();
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const connect = useMutation({
    mutationFn: (o: { offer: ConnectorOffer; headers?: Record<string, string> }) =>
      api.connectSuggestion(projectId, threadId, suggestion.id, { offerId: o.offer.id, ...(o.headers && { headers: o.headers }) }),
    onSuccess: (res) => {
      if (res.authorizeUrl) void platform.openExternal(res.authorizeUrl);
    },
  });
  const dismiss = useMutation({ mutationFn: () => api.dismissSuggestion(projectId, threadId, suggestion.id) });

  const open = suggestion.state === "open";
  const busy = connect.isPending || dismiss.isPending;
  const limited = connect.error instanceof ApiError && connect.error.status === 402;
  const error = connect.error ?? dismiss.error;
  const connected = suggestion.offers.find((o) => o.id === suggestion.connected);

  function start(offer: ConnectorOffer) {
    void Haptics.selectionAsync();
    if (offer.auth === "headers") {
      setKeyFor(offer.id);
      setKey("");
    } else connect.mutate({ offer });
  }

  return (
    <View style={[styles.card, open ? styles.cardOpen : styles.cardDone]}>
      <View style={styles.kicker}>
        {suggestion.state === "connected" ? (
          <CircleCheck size={15} color={colors.subtle} />
        ) : suggestion.state === "dismissed" ? (
          <CircleSlash size={15} color={colors.subtle} />
        ) : (
          <Plug size={15} color={colors.accent} />
        )}
        <Text style={{ fontSize: 13, color: open ? colors.accent : colors.subtle }}>
          {suggestion.state === "connected"
            ? t("suggestion.connected", { name: connected?.name ?? "" })
            : suggestion.state === "dismissed"
              ? t("suggestion.dismissed")
              : t("suggestion.title")}
        </Text>
      </View>
      <Text style={styles.reason}>{suggestion.reason}</Text>
      <View style={{ gap: 8 }}>
        {suggestion.offers.map((offer) => {
          const picked = offer.id === suggestion.connected;
          return (
            <View key={offer.id} style={[styles.offer, picked ? styles.offerPicked : null, !open && !picked ? { opacity: 0.6 } : null]}>
              <View style={styles.offerHead}>
                <View style={styles.icon}>
                  <Text style={styles.iconText}>{offer.name.slice(0, 1).toUpperCase()}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {offer.name}
                  </Text>
                  {!!offer.description && (
                    <Text style={styles.description} numberOfLines={2}>
                      {offer.description}
                    </Text>
                  )}
                </View>
                {picked && <CircleCheck size={16} color={colors.accent} />}
              </View>
              {open && keyFor === offer.id && offer.headerHint ? (
                <View style={{ gap: 8 }}>
                  <Input
                    secureTextEntry
                    autoFocus
                    accessibilityLabel={t("suggestion.keyLabel", { name: offer.headerHint.name, service: offer.name })}
                    placeholder={offer.headerHint.placeholder || offer.headerHint.name}
                    value={key}
                    onChangeText={setKey}
                  />
                  <Button
                    disabled={!key.trim()}
                    pending={connect.isPending}
                    onPress={() => connect.mutate({ offer, headers: { [offer.headerHint!.name]: key.trim() } })}
                  >
                    {t("suggestion.connect")}
                  </Button>
                </View>
              ) : open ? (
                <Button pending={connect.isPending && connect.variables?.offer.id === offer.id} disabled={busy} onPress={() => start(offer)}>
                  {t("suggestion.connect")}
                </Button>
              ) : null}
            </View>
          );
        })}
      </View>
      {open && (
        <>
          {limited ? (
            <Text style={styles.warn}>
              {t("suggestion.limit")}{" "}
              <Text style={styles.link} accessibilityRole="link" onPress={() => router.push("/settings")}>
                {t("suggestion.upgrade")}
              </Text>
            </Text>
          ) : error ? (
            <Text style={styles.bad}>
              {error instanceof ApiError && error.status === 404 ? t("suggestion.answered") : errorMessage(error, t("common.error"))}
            </Text>
          ) : null}
          <Text style={styles.note}>{t("suggestion.yours")}</Text>
          <Button variant="ghost" disabled={busy} onPress={() => dismiss.mutate()}>
            {t("suggestion.notNow")}
          </Button>
        </>
      )}
    </View>
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    card: { gap: 12, borderRadius: radius.lg, borderWidth: 1, padding: 14 },
    cardOpen: { borderColor: colors.accentBorderSoft, backgroundColor: colors.accentWash },
    cardDone: { borderColor: colors.line, backgroundColor: colors.raised },
    kicker: { flexDirection: "row", alignItems: "center", gap: 8 },
    reason: { color: colors.body, fontSize: 15, lineHeight: 21 },
    offer: { gap: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.edge, backgroundColor: colors.panel, padding: 12 },
    offerPicked: { borderColor: colors.accentBorder, backgroundColor: colors.accentSoft },
    offerHead: { flexDirection: "row", alignItems: "center", gap: 10 },
    icon: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.hover, alignItems: "center", justifyContent: "center" },
    iconText: { color: colors.muted, fontSize: 15, fontWeight: "600" },
    name: { color: colors.fg, fontSize: 15, fontWeight: "600" },
    description: { color: colors.muted, fontSize: 13, lineHeight: 18 },
    note: { color: colors.subtle, fontSize: 12, lineHeight: 17 },
    warn: { color: colors.warn, fontSize: 14 },
    link: { color: colors.link, fontWeight: "600" },
    bad: { color: colors.bad, fontSize: 14 },
  }),
);
