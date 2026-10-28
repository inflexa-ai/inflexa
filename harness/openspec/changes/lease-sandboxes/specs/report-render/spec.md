## ADDED Requirements

### Requirement: Each evidentiary binding joins the References appendix
The binding of each evidentiary block MUST join the ladder: the metric value, the table, the chart, and the figure beside the claim and the citation. The card shows the marker, and the appendix entry names the path in its entry form.

A chart MUST also mark its track and each of its statistics. The title line of the chart carries one marker for each reference, in block order: the binding, the track, then each statistic. The appendix lists each one, and a statistic lists with its path and its locator.

#### Scenario: A bound table gains its appendix entry
- **WHEN** the caller renders a table block over a pinned artifact
- **THEN** the card carries a marker, and the appendix names the path

#### Scenario: A chart marks its track and its statistics
- **WHEN** the caller renders a chart with a track and two statistics
- **THEN** the title line carries four markers in block order, and the appendix holds four entries

## REMOVED Requirements

### Requirement: Every evidentiary binding joins the References appendix

**Reason**: The requirement drops the chain of a derived path. A MODIFIED block cannot drop a scenario, thus the requirement continues under a new name.

**Migration**: Refer to the ADDED requirement "Each evidentiary binding joins the References appendix".
