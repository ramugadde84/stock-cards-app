/**
 * S&P 500 ticker universe
 * ------------------------
 * MAINTENANCE NOTE — read this before trusting it as gospel:
 * S&P 500 membership changes several times a year (additions, removals,
 * mergers, ticker changes). This list is a snapshot and WILL drift. It's
 * good enough for "what's moving after hours", where missing a couple of
 * recent additions doesn't matter much — but it is not an authoritative
 * index constituent list.
 *
 * To refresh it, the official source is S&P Dow Jones Indices; Wikipedia's
 * "List of S&P 500 companies" is the usual practical shortcut. Just replace
 * the array below.
 *
 * TOP_100 is a curated subset of the largest / most actively traded names.
 * Scanning 100 tickers takes a few seconds; scanning all ~500 takes
 * substantially longer, so the UI defaults to the smaller set.
 */

const SP500 = [
  'A','AAPL','ABBV','ABNB','ABT','ACGL','ACN','ADBE','ADI','ADM','ADP','ADSK','AEE','AEP','AES',
  'AFL','AIG','AIZ','AJG','AKAM','ALB','ALGN','ALL','ALLE','AMAT','AMCR','AMD','AME','AMGN','AMP',
  'AMT','AMZN','ANET','ANSS','AON','AOS','APA','APD','APH','APTV','ARE','ATO','AVB','AVGO','AVY',
  'AWK','AXON','AXP','AZO','BA','BAC','BALL','BAX','BBWI','BBY','BDX','BEN','BF.B','BG','BIIB',
  'BK','BKNG','BKR','BLDR','BLK','BMY','BR','BRK.B','BRO','BSX','BX','BXP','C','CAG','CAH',
  'CARR','CAT','CB','CBOE','CBRE','CCI','CCL','CDNS','CDW','CE','CEG','CF','CFG','CHD','CHRW',
  'CHTR','CI','CINF','CL','CLX','CMA','CMCSA','CME','CMG','CMI','CMS','CNC','CNP','COF','COO',
  'COP','COR','COST','CPB','CPRT','CPT','CRL','CRM','CSCO','CSGP','CSX','CTAS','CTLT','CTRA','CTSH',
  'CTVA','CVS','CVX','CZR','D','DAL','DAY','DD','DE','DECK','DFS','DG','DGX','DHI','DHR',
  'DIS','DLR','DLTR','DOC','DOV','DOW','DPZ','DRI','DTE','DUK','DVA','DVN','DXCM','EA','EBAY',
  'ECL','ED','EFX','EG','EIX','EL','ELV','EMN','EMR','ENPH','EOG','EPAM','EQIX','EQR','EQT',
  'ES','ESS','ETN','ETR','EVRG','EW','EXC','EXPD','EXPE','EXR','F','FANG','FAST','FCX','FDS',
  'FDX','FE','FFIV','FI','FICO','FIS','FITB','FMC','FOX','FOXA','FRT','FSLR','FTNT','FTV','GD',
  'GE','GEHC','GEN','GEV','GILD','GIS','GL','GLW','GM','GNRC','GOOG','GOOGL','GPC','GPN','GRMN',
  'GS','GWW','HAL','HAS','HBAN','HCA','HD','HES','HIG','HII','HLT','HOLX','HON','HPE','HPQ',
  'HRL','HSIC','HST','HSY','HUBB','HUM','HWM','IBM','ICE','IDXX','IEX','IFF','INCY','INTC','INTU',
  'INVH','IP','IPG','IQV','IR','IRM','ISRG','IT','ITW','IVZ','J','JBHT','JBL','JCI','JKHY',
  'JNJ','JNPR','JPM','K','KDP','KEY','KEYS','KHC','KIM','KKR','KLAC','KMB','KMI','KMX','KO',
  'KR','KVUE','L','LDOS','LEN','LH','LHX','LIN','LKQ','LLY','LMT','LNT','LOW','LRCX','LULU',
  'LUV','LVS','LW','LYB','LYV','MA','MAA','MAR','MAS','MCD','MCHP','MCK','MCO','MDLZ','MDT',
  'MET','META','MGM','MHK','MKC','MKTX','MLM','MMC','MMM','MNST','MO','MOH','MOS','MPC','MPWR',
  'MRK','MRNA','MS','MSCI','MSFT','MSI','MTB','MTCH','MTD','MU','NCLH','NDAQ','NDSN','NEE','NEM',
  'NFLX','NI','NKE','NOC','NOW','NRG','NSC','NTAP','NTRS','NUE','NVDA','NVR','NWS','NWSA','NXPI',
  'O','ODFL','OKE','OMC','ON','ORCL','ORLY','OTIS','OXY','PANW','PARA','PAYC','PAYX','PCAR','PCG',
  'PEG','PEP','PFE','PFG','PG','PGR','PH','PHM','PKG','PLD','PLTR','PM','PNC','PNR','PNW',
  'PODD','POOL','PPG','PPL','PRU','PSA','PSX','PTC','PWR','PYPL','QCOM','QRVO','RCL','REG','REGN',
  'RF','RJF','RL','RMD','ROK','ROL','ROP','ROST','RSG','RTX','RVTY','SBAC','SBUX','SCHW','SHW',
  'SJM','SLB','SMCI','SNA','SNPS','SO','SOLV','SPG','SPGI','SRE','STE','STLD','STT','STX','STZ',
  'SW','SWK','SWKS','SYF','SYK','SYY','T','TAP','TDG','TDY','TECH','TEL','TER','TFC','TFX',
  'TGT','TJX','TMO','TMUS','TPR','TRGP','TRMB','TROW','TRV','TSCO','TSLA','TSN','TT','TTWO','TXN',
  'TXT','TYL','UAL','UBER','UDR','UHS','ULTA','UNH','UNP','UPS','URI','USB','V','VICI','VLO',
  'VLTO','VMC','VRSK','VRSN','VRTX','VST','VTR','VTRS','VZ','WAB','WAT','WBA','WBD','WDC','WEC',
  'WELL','WFC','WM','WMB','WMT','WRB','WST','WTW','WY','WYNN','XEL','XOM','XYL','YUM','ZBH',
  'ZBRA','ZTS',
];

/**
 * Largest / most actively traded names — the default scan set.
 * These are where after-hours moves are most liquid and most meaningful;
 * a thin post-market print on a small constituent is often just noise.
 */
const TOP_100 = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','GOOG','META','TSLA','BRK.B','AVGO',
  'LLY','JPM','V','XOM','UNH','MA','COST','HD','PG','JNJ',
  'WMT','NFLX','ABBV','CRM','BAC','ORCL','MRK','KO','AMD','CVX',
  'PEP','ADBE','LIN','TMO','ACN','CSCO','MCD','ABT','WFC','GE',
  'PM','DHR','IBM','TXN','NOW','QCOM','INTU','CAT','VZ','AMGN',
  'DIS','CMCSA','PFE','RTX','SPGI','UBER','AMAT','ISRG','GS','NEE',
  'HON','UNP','LOW','PLTR','T','ETN','BLK','TJX','COP','SYK',
  'BSX','VRTX','MS','PGR','C','ADP','LRCX','MU','BX','SCHW',
  'FI','MDT','GILD','REGN','ADI','CB','MMC','SBUX','DE','LMT',
  'BMY','PANW','ANET','KLAC','MDLZ','TMUS','SMCI','MRNA','ENPH','CEG',
];

module.exports = { SP500, TOP_100 };
