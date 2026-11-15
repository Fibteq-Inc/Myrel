import { Stack, useLocalSearchParams } from "expo-router";
import { ProjectProvider } from "../../../../lib/project";
import { useColors } from "../../../../theme";

/** One live connection per open project, shared by its chat and its threads. */
export default function ProjectLayout() {
  const colors = useColors();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  return (
    <ProjectProvider projectId={projectId}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.ground },
          headerTintColor: colors.fg,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.ground },
          headerBackButtonDisplayMode: "minimal",
        }}
      />
    </ProjectProvider>
  );
}
