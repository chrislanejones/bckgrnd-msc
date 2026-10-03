import { createFileRoute } from "@tanstack/react-router";
import { FloorDeck } from "@/components/floor-deck";

export const Route = createFileRoute("/")({ component: FloorDeck });
