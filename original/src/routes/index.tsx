import { createFileRoute } from "@tanstack/react-router";
import { BckgrndDeck } from "@/components/bckgrnd-deck";

export const Route = createFileRoute("/")({ component: BckgrndDeck });
