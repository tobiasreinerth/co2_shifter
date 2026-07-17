"""XML helpers shared by every ENTSO-E document parser (A75 generation, A44
day-ahead prices, and any future document type).

ENTSO-E's XML schemas vary by document type but share the same namespace
quirks (a single default namespace per document) and the same "valid query,
no data" signal (HTTP 200 with an Acknowledgement_MarketDocument instead of
the expected root element).
"""

from xml.etree import ElementTree

RESOLUTION_MINUTES = {"PT15M": 15, "PT30M": 30, "PT60M": 60}


def _localname(tag: str) -> str:
    """Strips the XML namespace from a tag ('{ns}Point' → 'Point')."""
    return tag.rsplit("}", 1)[-1]


def _find(el: ElementTree.Element, name: str) -> ElementTree.Element | None:
    """Returns the first descendant with the given namespace-free tag name."""
    for child in el.iter():
        if _localname(child.tag) == name:
            return child
    return None


def _findall(el: ElementTree.Element, name: str) -> list[ElementTree.Element]:
    """Returns all descendants with the given namespace-free tag name."""
    return [child for child in el.iter() if _localname(child.tag) == name]


def raise_if_acknowledgement(xml_text: str) -> None:
    """Raises if the response is an Acknowledgement_MarketDocument.

    ENTSO-E answers HTTP 200 with an acknowledgement document instead of data
    when a query is valid but yields nothing (future date, wrong EIC, no
    publication yet). Surface its Reason text instead of parsing zero series.
    """
    try:
        root = ElementTree.fromstring(xml_text)
    except ElementTree.ParseError as exc:
        raise ValueError(f"ENTSO-E returned unparseable XML: {exc}") from exc
    if _localname(root.tag) != "Acknowledgement_MarketDocument":
        return
    reason_el = _find(root, "text")
    reason = (
        reason_el.text.strip() if reason_el is not None and reason_el.text else "no reason given"
    )
    raise ValueError(f"ENTSO-E returned no data: {reason}")
