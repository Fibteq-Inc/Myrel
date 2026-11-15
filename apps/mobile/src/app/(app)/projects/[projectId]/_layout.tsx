import { Stack, useLocalSearchParams } from "expo-router";
import { FileRefProvider } from "../../../../lib/file-refs";
import { ProjectProvider } from "../../../../lib/project";
import { useColors } from "../../../../theme";

/**
 * One live connection per open project, shared by its chat and its threads. Screens under the one in
 * front are frozen: every live event changes the project's state, and a project chat left drawing
 * underneath an open thread would redraw with each one. Which file paths in messages can open is
 * worked out once here too, not once per message.
 */
export default function ProjectLayout() {
  const colors = useColors();
  const { projectId } = useLocalSearchParams<{ projectId: string }>();
  return (
    <ProjectProvider projectId={projectId}>
      <FileRefProvider>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.ground },
            headerTintColor: colors.fg,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.ground },
            headerBackButtonDisplayMode: "minimal",
            freezeOnBlur: true,
          }}
        />
      </FileRefProvider>
    </ProjectProvider>
  );
}
