import { Box, Text, useInput } from "ink";
import type { SkillIndexEntry } from "@openacme/skills";

export function SkillsOverlay({
  skills,
  onClose,
}: {
  skills: SkillIndexEntry[];
  onClose: () => void;
}) {
  useInput((_, key) => {
    if (key.escape) onClose();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginBottom={1}
    >
      <Text bold color="magenta">
        Skills{skills.length > 0 ? ` (${skills.length})` : ""}
      </Text>
      {skills.length === 0 ? (
        <Text dimColor>
          No skills installed. Add one with `openacme skills add &lt;path&gt;`.
        </Text>
      ) : (
        skills.map((s) => (
          <Box key={s.name} flexDirection="column" marginTop={1}>
            <Box>
              <Text color="cyan">{s.name}</Text>
              {s.tags.length > 0 && (
                <Text dimColor>{`  [${s.tags.join(", ")}]`}</Text>
              )}
            </Box>
            <Text dimColor>{`  ${s.description}`}</Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>
          Esc to close · view full body with `openacme skills view &lt;name&gt;`
        </Text>
      </Box>
    </Box>
  );
}
