import { Text } from "ink";
import Gradient from "ink-gradient";

const LOGO = [
  "   ▄▄▄    ",
  "    █     ",
  " ▄██████▄ ",
  "██  ██  ██",
  "██████████",
].join("\n");

export function Logo() {
  return (
    <Gradient name="atlas">
      <Text>{LOGO}</Text>
    </Gradient>
  );
}
