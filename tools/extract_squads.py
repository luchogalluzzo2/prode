#!/usr/bin/env python3
"""Generate the static World Cup squad catalog from FIFA's squad-list PDF."""

import json
import re
import sys
from pathlib import Path

from pypdf import PdfReader


ROW_PATTERN = re.compile(r"^\s*(\d{1,2})\s*(PO|DF|MC|DC)\s+(.*?)\s{2,}")
TEAM_PATTERN = re.compile(r"^\s*(.+?) \(([A-Z]{3})\)\s*$", re.MULTILINE)


def clean_pdf_spacing(value):
    value = value.replace("\x00", "")
    value = re.sub(r"\bM (?=[A-Z])", "M", value)
    return re.sub(r"\s+", " ", value).strip()


def looks_like_surname_token(token):
    letters = re.sub(r"[^A-Za-zÀ-ÖØ-Þ]", "", token)
    return bool(letters) and (letters.isupper() or re.fullmatch(r"Mc[A-Z]+", letters))


def display_name(fifa_name):
    fifa_name = clean_pdf_spacing(fifa_name)
    parts = fifa_name.split()
    first_given = next(
        (index for index, part in enumerate(parts) if not looks_like_surname_token(part)),
        None,
    )
    if first_given:
        parts = parts[first_given:] + parts[:first_given]
    return " ".join(part.title() for part in parts)


def extract_squads(pdf_path):
    squads = {}
    for page_number, page in enumerate(PdfReader(pdf_path).pages, start=1):
        text = page.extract_text(extraction_mode="layout") or ""
        team_match = TEAM_PATTERN.search(text)
        if not team_match:
            raise ValueError(f"No se encontro el pais en la pagina {page_number}")

        _, team_code = team_match.groups()
        players = []
        for line in text.splitlines():
            row_match = ROW_PATTERN.match(line)
            if not row_match:
                continue
            _, position, fifa_name = row_match.groups()
            players.append(
                {
                    "name": display_name(fifa_name),
                    "position": position,
                }
            )

        if len(players) != 26:
            raise ValueError(
                f"{team_code}: se esperaban 26 jugadores y se encontraron {len(players)}"
            )
        squads[team_code] = players

    return squads


def main():
    if len(sys.argv) != 3:
        raise SystemExit("Uso: extract_squads.py PDF SALIDA_JS")

    pdf_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    squads = extract_squads(pdf_path)
    payload = json.dumps(squads, ensure_ascii=False, indent=2)
    output_path.write_text(
        "// Generado desde SquadLists-Spanish.pdf. No editar manualmente.\n"
        f"export const SQUADS = {payload};\n",
        encoding="utf-8",
    )
    print(f"Generados {sum(map(len, squads.values()))} jugadores de {len(squads)} paises.")


if __name__ == "__main__":
    main()
