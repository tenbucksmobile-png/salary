-- Add CFE Management hotel (Botswana entity)
INSERT INTO hotels (name, short_code, country, wca_rate)
VALUES ('CFE Management', 'CFEM', 'Botswana', 0.0050)
ON CONFLICT (short_code) DO NOTHING;
