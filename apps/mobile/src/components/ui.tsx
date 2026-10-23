import { LoaderCircle } from "lucide-react-native";
import { useI18n } from "@myrel/i18n/react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
  type ViewStyle,
} from "react-native";
import Svg, { Path } from "react-native-svg";
import { makeStyles, radius, useColors, useTheme } from "../theme";

export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export function Button({
  children,
  onPress,
  disabled,
  pending,
  variant = "primary",
  style,
}: {
  children: ReactNode;
  onPress?: () => void;
  disabled?: boolean;
  pending?: boolean;
  variant?: "primary" | "ghost";
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useColors();
  const styles = useStyles();
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled || pending}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primary : styles.ghost,
        (disabled || pending) && { opacity: 0.5 },
        pressed && { opacity: 0.8 },
        style,
      ]}
    >
      {pending ? (
        <ActivityIndicator color={primary ? colors.onAccent : colors.fg} />
      ) : (
        <Text style={[styles.buttonText, { color: primary ? colors.onAccent : colors.fg }]}>{children}</Text>
      )}
    </Pressable>
  );
}

export function Input(props: TextInputProps) {
  const theme = useTheme();
  const colors = useColors();
  const styles = useStyles();
  return (
    <TextInput
      placeholderTextColor={colors.subtle}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardAppearance={theme}
      {...props}
      style={[styles.input, props.style]}
    />
  );
}

/** A turning LoaderCircle, like `animate-spin` on web. */
export function Spinner({ size = 16, color }: { size?: number; color?: string }) {
  const colors = useColors();
  const turn = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(turn, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return (
    <Animated.View style={{ transform: [{ rotate }] }} accessibilityElementsHidden importantForAccessibility="no">
      <LoaderCircle size={size} color={color ?? colors.accent} />
    </Animated.View>
  );
}

/** The Myrel mark, as in the web app: a sparkle on a soft indigo tile. */
/** The four-petal mark (same as the app icon). */
const MARK_PETAL = "M512 512C512 360 600 250 700 250C760 250 790 300 770 350C740 430 620 470 512 512Z";

export function MyrelMark({ size = 28 }: { size?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: "#5148e6",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Svg width={size * 0.62} height={size * 0.62} viewBox="232 232 560 560">
        {[0, 90, 180, 270].map((angle) => (
          <Path key={angle} d={MARK_PETAL} fill="#f4efe6" transform={`rotate(${angle} 512 512)`} />
        ))}
      </Svg>
    </View>
  );
}

/** "now", "5m", "3h", "2d", then a short date, in the app's language. */
export function useRelativeTime() {
  const { t, locale } = useI18n();
  return useCallback(
    (iso: string, now = Date.now()) => {
      const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
      if (s < 60) return t("time.now");
      if (s < 3600) return t("time.minutes", { count: Math.floor(s / 60) });
      if (s < 86400) return t("time.hours", { count: Math.floor(s / 3600) });
      if (s < 7 * 86400) return t("time.days", { count: Math.floor(s / 86400) });
      return new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric" });
    },
    [t, locale],
  );
}

const useStyles = makeStyles((colors) =>
  StyleSheet.create({
    button: {
      minHeight: 46,
      borderRadius: radius.md,
      paddingHorizontal: 16,
      alignItems: "center",
      justifyContent: "center",
    },
    primary: { backgroundColor: colors.accent },
    ghost: { backgroundColor: "transparent", borderWidth: 1, borderColor: colors.edge },
    buttonText: { fontSize: 15, fontWeight: "600" },
    input: {
      minHeight: 46,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: colors.edge,
      backgroundColor: colors.raised,
      color: colors.fg,
      paddingHorizontal: 14,
      fontSize: 15,
    },
  }),
);
