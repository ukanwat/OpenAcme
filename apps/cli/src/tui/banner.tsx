import React from "react";
import { Box, Text, render } from "ink";
import BigText from "ink-big-text";
import Gradient from "ink-gradient";
import { Logo } from "./components/Logo.js";

function StartupBanner({ version }: { version: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={0}
      marginBottom={1}
    >
      <Box flexDirection="row">
        <Box marginRight={2}>
          <Logo />
        </Box>
        <Gradient name="atlas">
          <BigText text="OpenAcme" font="tiny" />
        </Gradient>
      </Box>
      <Box marginTop={0}>
        <Text dimColor>
          Agent platform · <Text color="cyan">v{version}</Text>
        </Text>
      </Box>
    </Box>
  );
}

export async function showBanner(version: string): Promise<void> {
  const instance = render(<StartupBanner version={version} />);
  instance.unmount();
  await instance.waitUntilExit();
}
