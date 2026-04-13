export interface SheetFormat {
  headerStyle: {
    bold: boolean;
    frozen: boolean;
    backgroundColor: string; // #1A73E8
    textColor: string; // #FFFFFF
  };
  alternatingRowColors: { color1: string; color2: string };
  numericAlignment: 'RIGHT';
  atRiskColors: {
    overdue: string; // #FF0000
    inactive: string; // #FF9900
    open_too_long: string; // #FFFF00
    high_rework: string; // #FF9900
  };
}

export interface ChartSpec {
  type: 'BAR' | 'LINE' | 'PIE' | 'STACKED_BAR';
  title: string;
  dataRange: {
    sheetId: number;
    startRowIndex: number;
    endRowIndex: number;
    startColumnIndex: number;
    endColumnIndex: number;
  };
  position: {
    sheetId: number;
    offsetXPixels: number;
    offsetYPixels: number;
  };
  size: { width: 600; height: 371 };
}
